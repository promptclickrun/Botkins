// A key that signs only after the person has shown they are holding the phone (iPhone).
//
//   available() -> Bool                       the phone has a passcode, so such a key can exist
//   create(tag) -> String                     a new P-256 key; answers its public half (SPKI, base64url)
//   has(tag) -> Bool
//   sign(tag, message, reason) -> String      ECDSA P-256 with SHA-256 over the message's UTF-8 bytes,
//                                             as DER in base64url, after Face ID, Touch ID or the passcode
//   remove(tag)
//
// The private key is made in the Secure Enclave where the phone has one (it can't be read out, by
// this app either) and is bound to "user presence": every use asks for Face ID, Touch ID or the
// passcode. A simulator has no Secure Enclave; there the key is an ordinary keychain key with the
// same rule. It is kept on this device only and only while the phone has a passcode: taking the
// passcode off removes it. Nothing here signs without that question, and there is no way to hand in
// a key from outside.
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

private let keyPrefix = "app.botkins.presence."
// The fixed start of a P-256 public key in SPKI form; the 65 bytes of the point follow it.
private let spkiHead: [UInt8] = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
  0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]

public class BotkinsPresenceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BotkinsPresence")

    Function("available") { () -> Bool in
      LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    AsyncFunction("create") { (tag: String) -> String in
      try self.create(tag)
    }

    Function("has") { (tag: String) -> Bool in
      self.exists(tag)
    }

    AsyncFunction("sign") { (tag: String, message: String, reason: String, promise: Promise) in
      // The question to the person blocks until it is answered: not on the main thread.
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try self.sign(tag, message, reason))
        } catch let error as Exception {
          promise.reject(error)
        } catch {
          promise.reject(Exception(name: "E_PRESENCE", description: "This phone couldn't confirm it was you."))
        }
      }
    }

    AsyncFunction("remove") { (tag: String) in
      self.remove(tag)
    }
  }

  private func tagData(_ tag: String) throws -> Data {
    guard !tag.isEmpty, tag.count <= 80, tag.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else {
      throw Exception(name: "E_PRESENCE", description: "That key has no usable name.")
    }
    return Data((keyPrefix + tag).utf8)
  }

  private func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func query(_ tag: Data) -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag as String: tag,
    ]
  }

  private func exists(_ tag: String) -> Bool {
    guard let data = try? tagData(tag) else { return false }
    var find = query(data)
    // Looking, not using: iOS must not ask the person anything for this.
    find[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    let status = SecItemCopyMatching(find as CFDictionary, nil)
    return status == errSecSuccess || status == errSecInteractionNotAllowed
  }

  private func remove(_ tag: String) {
    guard let data = try? tagData(tag) else { return }
    SecItemDelete(query(data) as CFDictionary)
  }

  private func create(_ tag: String) throws -> String {
    let data = try tagData(tag)
    SecItemDelete(query(data) as CFDictionary)
    var made: SecKey?
    var problem: Unmanaged<CFError>?
    // The Secure Enclave first; a simulator has none, and gets a keychain key under the same rule.
    var tries: [(enclave: Bool, kept: CFString)] = [(true, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly), (false, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly)]
    #if targetEnvironment(simulator)
    // A simulator can't have a passcode, so "only while a passcode is set" can never hold there.
    tries.append((false, kSecAttrAccessibleWhenUnlockedThisDeviceOnly))
    #endif
    for (enclave, kept) in tries {
      var flags: SecAccessControlCreateFlags = [.userPresence]
      if enclave { flags.insert(.privateKeyUsage) }
      guard let access = SecAccessControlCreateWithFlags(nil, kept, flags, nil) else { continue }
      var attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: data,
          kSecAttrAccessControl as String: access,
        ] as [String: Any],
      ]
      if enclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
      problem = nil
      if let key = SecKeyCreateRandomKey(attributes as CFDictionary, &problem) {
        made = key
        break
      }
    }
    guard let key = made, let open = SecKeyCopyPublicKey(key), let point = SecKeyCopyExternalRepresentation(open, nil) as Data?, point.count == 65 else {
      throw Exception(name: "E_PRESENCE", description: "This phone can't keep a key behind Face ID or a passcode. Set a passcode and try again.")
    }
    return base64url(Data(spkiHead) + point)
  }

  private func sign(_ tag: String, _ message: String, _ reason: String) throws -> String {
    let data = try tagData(tag)
    let context = LAContext()
    let why = reason.isEmpty ? "Confirm it's you" : reason
    context.localizedReason = why
    // The question is asked outright, every time, and its answer is what the key is then used with.
    // A phone's key would ask by itself; a simulator's keychain doesn't hold a key to that rule, so
    // relying on the key alone would let a simulator sign without asking.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
      throw Exception(name: "E_PRESENCE", description: "This phone can't check it's you. Set a passcode and try again.")
    }
    let answered = DispatchSemaphore(value: 0)
    var confirmed = false
    var refusal: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: why) { ok, error in
      confirmed = ok
      refusal = error
      answered.signal()
    }
    answered.wait()
    guard confirmed else {
      let code = (refusal as NSError?)?.code ?? 0
      if code == LAError.userCancel.rawValue || code == LAError.appCancel.rawValue || code == LAError.systemCancel.rawValue {
        throw Exception(name: "E_PRESENCE_CANCELLED", description: "Not confirmed.")
      }
      throw Exception(name: "E_PRESENCE", description: "This phone couldn't confirm it was you.")
    }
    var find = query(data)
    find[kSecReturnRef as String] = true
    find[kSecUseAuthenticationContext as String] = context
    var found: CFTypeRef?
    guard SecItemCopyMatching(find as CFDictionary, &found) == errSecSuccess, let item = found else {
      throw Exception(name: "E_PRESENCE_NO_KEY", description: "This phone has no key for that computer.")
    }
    let key = item as! SecKey
    var problem: Unmanaged<CFError>?
    // The key is used with the answer just given (on a phone it would refuse to sign without one).
    guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &problem) as Data? else {
      let code = (problem?.takeRetainedValue() as Error?).map { ($0 as NSError).code } ?? 0
      if code == LAError.userCancel.rawValue || code == LAError.appCancel.rawValue || code == LAError.systemCancel.rawValue {
        throw Exception(name: "E_PRESENCE_CANCELLED", description: "Not confirmed.")
      }
      throw Exception(name: "E_PRESENCE", description: "This phone couldn't confirm it was you.")
    }
    return base64url(signature)
  }
}
