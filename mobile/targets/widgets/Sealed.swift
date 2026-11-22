// What only this phone sees of a Botkin's card (docs/live-cards.md, section 5): the chats' titles,
// steps, thinking and requests. The computer (or the app, while it runs) seals them with the push
// key of the pairing, and they are opened here, as the card is drawn, with the keys the app keeps in
// the keychain group this extension shares with it. Apple carries only the box. When it can't be
// opened (no key yet, or another computer's card), the card shows what Apple may see.
import CryptoKit
import Foundation
import Security

struct CardDetail: Decodable {
  let c: [Chat]

  struct Chat: Decodable {
    let id: String
    /// The chat's title.
    let t: String
    /// What it is doing now, in a few words.
    let l: String
    /// The Botkin's name, on the card for all Botkins.
    let b: String?
    /// The model's id.
    let m: String?
    /// The last three steps, when the card shows one chat.
    let s: [Step]?
    /// The latest sentence of thinking.
    let th: String?
    /// The reply's first line, once done.
    let r: String?
    /// The chat's oldest open request.
    let q: Ask?
  }

  struct Step: Decodable, Hashable {
    /// run, read, edit, search, web, helper or tool
    let k: String
    let l: String
    /// 0 running, 1 done, 2 failed
    let d: Int
    let at: Double?
  }

  struct Ask: Decodable {
    let id: String
    /// permission, question, form or secure
    let k: String
    let t: String
    let p: String?
    let ch: [String]?
    let rm: Bool?
    let free: Bool?
  }

  func chat(_ id: String) -> Chat? { c.first { $0.id == id } }
}

enum Sealed {
  private static let aad = Data("botkins-card-v1".utf8)

  /// The detail, and the id of the computer whose key opened it.
  static func open(_ sealed: String?) -> (detail: CardDetail, host: String?)? {
    guard let sealed, let data = Data(base64Encoded: sealed), data.count > 28, let box = try? ChaChaPoly.SealedBox(combined: data) else { return nil }
    for (host, key) in keys() {
      guard let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: aad),
            let detail = try? JSONDecoder().decode(CardDetail.self, from: plain) else { continue }
      return (detail, host)
    }
    return nil
  }

  /// Every push key the app keeps: one for each paired computer ("key:<id>"), or the single "key" of an older build.
  private static func keys() -> [(String?, Data)] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.botkins.push",
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    if let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsKeychainGroup") as? String, !group.isEmpty {
      query[kSecAttrAccessGroup as String] = group
    }
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let items = found as? [[String: Any]] else { return [] }
    var keys: [(String?, Data)] = []
    for item in items {
      guard let key = item[kSecValueData as String] as? Data, key.count == 32, let account = item[kSecAttrAccount as String] as? String else { continue }
      if account.hasPrefix("key:") { keys.append((String(account.dropFirst(4)), key)) }
      else if account == "key" { keys.append((nil, key)) }
    }
    return keys
  }
}
