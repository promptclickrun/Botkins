// Native iOS Share Extension for Botkins.
// Accepts links, text, photos, videos, and arbitrary files from any app's Share Sheet, lets the
// person pick which Botkin to send to and add optional context, stages the payload into the shared
// App Group container (`group.app.botkins.mobile/shares/<id>/`), and opens `botkins://open/share?id=<id>`
// so the main app uploads any files and sends the message cleanly in that bot's chat.
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Shared App Group models

private struct ShareSnapshot: Decodable {
  let inUse: String?
  let computers: [String: Computer]

  struct Computer: Decodable {
    let name: String
    let bots: [Bot]
  }

  struct Bot: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let role: String
    let pinned: Bool?
  }

  struct Choice: Identifiable, Hashable {
    let hostId: String
    let hostName: String
    let bot: Bot
    var id: String { "\(hostId):\(bot.id)" }
  }

  static func loadChoices(group: String) -> (choices: [Choice], primaryHost: String?) {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let data = try? Data(contentsOf: container.appendingPathComponent("widgets.json")),
          let snap = try? JSONDecoder().decode(ShareSnapshot.self, from: data) else {
      return ([], nil)
    }
    var out: [Choice] = []
    let orderedHosts: [String] = {
      var keys = Array(snap.computers.keys).sorted()
      if let inUse = snap.inUse, let idx = keys.firstIndex(of: inUse) {
        keys.remove(at: idx)
        keys.insert(inUse, at: 0)
      }
      return keys
    }()
    for hostId in orderedHosts {
      guard let computer = snap.computers[hostId] else { continue }
      for bot in computer.bots {
        out.append(Choice(hostId: hostId, hostName: computer.name, bot: bot))
      }
    }
    return (out, snap.inUse)
  }
}

private struct StagedAttachment: Codable, Identifiable {
  let id: String
  let name: String
  let relativePath: String
  let mimeType: String
  let size: Int
  let kind: String // "image" | "video" | "file"
}

private struct StagedShare: Codable {
  let id: String
  let createdAt: Double
  let hostId: String?
  let botId: String?
  let note: String
  let text: String?
  let urls: [String]
  let attachments: [StagedAttachment]
}

private struct ExtractedContent {
  var texts: [String] = []
  var urls: [String] = []
  var attachments: [StagedAttachment] = []
}

// MARK: - View Controller

@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private let appGroup: String = {
    (Bundle.main.object(forInfoDictionaryKey: "BotkinsAppGroup") as? String) ?? "group.app.botkins.mobile"
  }()

  private let shareId = UUID().uuidString
  private var hosting: UIHostingController<ShareSheetView>?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear

    let (choices, _) = ShareSnapshot.loadChoices(group: appGroup)
    let model = ShareViewModel(
      shareId: shareId,
      appGroup: appGroup,
      choices: choices,
      extensionItems: (extensionContext?.inputItems as? [NSExtensionItem]) ?? [],
      onSend: { [weak self] url in self?.openMainAppAndFinish(url) },
      onCancel: { [weak self] in self?.cancelAndCleanUp() }
    )

    let root = ShareSheetView(model: model)
    let host = UIHostingController(rootView: root)
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    host.view.backgroundColor = .clear
    view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: view.topAnchor),
      host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    host.didMove(toParent: self)
    hosting = host
  }

  private func openMainAppAndFinish(_ url: URL) {
    // Open the host app via responder chain (standard iOS Share Extension handoff).
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        application.open(url, options: [:], completionHandler: nil)
        break
      }
      let openSel = NSSelectorFromString("openURL:")
      if current.responds(to: openSel) {
        current.perform(openSel, with: url)
        break
      }
      responder = current.next
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
      self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
  }

  private func cancelAndCleanUp() {
    if let dir = Self.shareDirectory(group: appGroup, id: shareId, create: false) {
      try? FileManager.default.removeItem(at: dir)
    }
    extensionContext?.cancelRequest(withError: NSError(domain: "app.botkins.share", code: 0, userInfo: [NSLocalizedDescriptionKey: "Cancelled"]))
  }

  fileprivate static func shareDirectory(group: String, id: String, create: Bool) -> URL? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
    let root = container.appendingPathComponent("shares", isDirectory: true)
    let dir = root.appendingPathComponent(id, isDirectory: true)
    if create {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return dir
  }
}

// MARK: - ViewModel & Extraction

@MainActor
private final class ShareViewModel: ObservableObject {
  let shareId: String
  let appGroup: String
  let choices: [ShareSnapshot.Choice]
  @Published var selectedChoiceId: String?
  @Published var note: String = ""
  @Published var loading: Bool = true
  @Published var sending: Bool = false
  @Published var errorMessage: String?
  @Published var content = ExtractedContent()

  private let extensionItems: [NSExtensionItem]
  private let onSend: (URL) -> Void
  private let onCancel: () -> Void

  init(
    shareId: String,
    appGroup: String,
    choices: [ShareSnapshot.Choice],
    extensionItems: [NSExtensionItem],
    onSend: @escaping (URL) -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.shareId = shareId
    self.appGroup = appGroup
    self.choices = choices
    self.selectedChoiceId = choices.first?.id
    self.extensionItems = extensionItems
    self.onSend = onSend
    self.onCancel = onCancel
    Task { await self.extract() }
  }

  var hasMultipleHosts: Bool {
    Set(choices.map(\.hostId)).count > 1
  }

  var selectedChoice: ShareSnapshot.Choice? {
    choices.first { $0.id == selectedChoiceId } ?? choices.first
  }

  var canSend: Bool {
    !loading && !sending && (
      !content.attachments.isEmpty ||
      !content.urls.isEmpty ||
      !content.texts.isEmpty ||
      !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    )
  }

  func cancel() {
    onCancel()
  }

  func send() {
    guard canSend else { return }
    sending = true
    errorMessage = nil
    guard let dir = ShareViewController.shareDirectory(group: appGroup, id: shareId, create: true) else {
      sending = false
      errorMessage = "Could not access shared storage."
      return
    }
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let joinedText = content.texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    let payload = StagedShare(
      id: shareId,
      createdAt: Date().timeIntervalSince1970,
      hostId: selectedChoice?.hostId,
      botId: selectedChoice?.bot.id,
      note: trimmedNote,
      text: joinedText.isEmpty ? nil : joinedText,
      urls: content.urls,
      attachments: content.attachments
    )
    do {
      let data = try JSONEncoder().encode(payload)
      let manifest = dir.appendingPathComponent("payload.json")
      try data.write(to: manifest, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var comps = URLComponents()
      comps.scheme = "botkins"
      comps.host = "open"
      comps.path = "/share"
      comps.queryItems = [URLQueryItem(name: "id", value: shareId)]
      guard let url = comps.url else {
        sending = false
        errorMessage = "Could not open Botkins."
        return
      }
      onSend(url)
    } catch {
      sending = false
      errorMessage = "Could not prepare shared content."
    }
  }

  private func extract() async {
    let dir = ShareViewController.shareDirectory(group: appGroup, id: shareId, create: true)
    var result = ExtractedContent()
    var seenUrls = Set<String>()
    var fileIndex = 0
    let maxAttachments = 10

    for item in extensionItems {
      let providers = item.attachments ?? []
      if providers.isEmpty, let attrText = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !attrText.isEmpty {
        result.texts.append(attrText)
      }
      for provider in providers {
        // 1. Web URLs (not local file URLs)
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
          if let url = await loadURL(provider) {
            if url.isFileURL {
              if let dir, result.attachments.count < maxAttachments, let staged = copyFile(url, into: dir, index: &fileIndex) {
                result.attachments.append(staged)
              }
            } else {
              let str = url.absoluteString
              if seenUrls.insert(str).inserted { result.urls.append(str) }
            }
            continue
          }
        }

        // 2. Images
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
          if let dir, result.attachments.count < maxAttachments, let staged = await loadAttachment(provider, type: .image, kind: "image", fallbackExt: "jpg", into: dir, index: &fileIndex) {
            result.attachments.append(staged)
            continue
          }
        }

        // 3. Videos / movies
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
          if let dir, result.attachments.count < maxAttachments, let staged = await loadAttachment(provider, type: .movie, kind: "video", fallbackExt: "mov", into: dir, index: &fileIndex) {
            result.attachments.append(staged)
            continue
          }
        }

        // 4. Generic files / documents / PDFs / archives
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
          let uti = provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .data) && !$0.conforms(to: .plainText) }
          if let uti, let dir, result.attachments.count < maxAttachments, let staged = await loadAttachment(provider, type: uti, kind: kindFor(uti), fallbackExt: uti.preferredFilenameExtension ?? "bin", into: dir, index: &fileIndex) {
            result.attachments.append(staged)
            continue
          }
        }

        // 5. Plain text
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          if let text = await loadText(provider) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
              if let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased(), (scheme == "http" || scheme == "https"), parsed.host != nil {
                if seenUrls.insert(trimmed).inserted { result.urls.append(trimmed) }
              } else {
                result.texts.append(trimmed)
              }
            }
          }
        }
      }
    }

    content = result
    loading = false
  }

  private func kindFor(_ type: UTType) -> String {
    if type.conforms(to: .image) { return "image" }
    if type.conforms(to: .movie) || type.conforms(to: .video) { return "video" }
    return "file"
  }

  private func loadURL(_ provider: NSItemProvider) async -> URL? {
    await withCheckedContinuation { cont in
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
        if let url = item as? URL {
          cont.resume(returning: url)
        } else if let str = item as? String, let url = URL(string: str) {
          cont.resume(returning: url)
        } else if let data = item as? Data, let str = String(data: data, encoding: .utf8), let url = URL(string: str.trimmingCharacters(in: .whitespacesAndNewlines)) {
          cont.resume(returning: url)
        } else {
          cont.resume(returning: nil)
        }
      }
    }
  }

  private func loadText(_ provider: NSItemProvider) async -> String? {
    await withCheckedContinuation { cont in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
        if let str = item as? String {
          cont.resume(returning: str)
        } else if let attr = item as? NSAttributedString {
          cont.resume(returning: attr.string)
        } else if let data = item as? Data {
          cont.resume(returning: String(data: data, encoding: .utf8))
        } else {
          cont.resume(returning: nil)
        }
      }
    }
  }

  private func loadAttachment(
    _ provider: NSItemProvider,
    type: UTType,
    kind: String,
    fallbackExt: String,
    into dir: URL,
    index: inout Int
  ) async -> StagedAttachment? {
    // Prefer loadFileRepresentation so large videos/files copy on disk instead of loading into RAM.
    let copiedURL: URL? = await withCheckedContinuation { cont in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        guard let url else {
          cont.resume(returning: nil)
          return
        }
        let tempName = UUID().uuidString + "-" + (url.lastPathComponent.isEmpty ? "item.\(fallbackExt)" : url.lastPathComponent)
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(tempName)
        do {
          try FileManager.default.copyItem(at: url, to: dest)
          cont.resume(returning: dest)
        } catch {
          cont.resume(returning: nil)
        }
      }
    }
    if let copiedURL {
      defer { try? FileManager.default.removeItem(at: copiedURL) }
      return copyFile(copiedURL, suggestedName: provider.suggestedName, forcedKind: kind, fallbackExt: fallbackExt, into: dir, index: &index)
    }

    // Fallback for in-memory UIImage or Data items.
    let itemData: Data? = await withCheckedContinuation { cont in
      provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
        if let image = item as? UIImage {
          cont.resume(returning: image.jpegData(compressionQuality: 0.9))
        } else if let data = item as? Data {
          cont.resume(returning: data)
        } else if let url = item as? URL {
          cont.resume(returning: try? Data(contentsOf: url))
        } else {
          cont.resume(returning: nil)
        }
      }
    }
    guard let itemData, !itemData.isEmpty else { return nil }
    index += 1
    let safeName = sanitizedName(provider.suggestedName, fallbackExt: fallbackExt, index: index)
    let rel = "files/\(index)-\(safeName)"
    let filesDir = dir.appendingPathComponent("files", isDirectory: true)
    try? FileManager.default.createDirectory(at: filesDir, withIntermediateDirectories: true)
    let dest = dir.appendingPathComponent(rel)
    do {
      try itemData.write(to: dest, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      let mime = type.preferredMIMEType ?? "application/octet-stream"
      return StagedAttachment(id: UUID().uuidString, name: safeName, relativePath: rel, mimeType: mime, size: itemData.count, kind: kind)
    } catch {
      return nil
    }
  }

  private func copyFile(
    _ source: URL,
    suggestedName: String? = nil,
    forcedKind: String? = nil,
    fallbackExt: String = "bin",
    into dir: URL,
    index: inout Int
  ) -> StagedAttachment? {
    let access = source.startAccessingSecurityScopedResource()
    defer { if access { source.stopAccessingSecurityScopedResource() } }
    index += 1
    let ext = source.pathExtension.isEmpty ? fallbackExt : source.pathExtension
    let rawName = (suggestedName?.isEmpty == false ? suggestedName! : source.lastPathComponent)
    let safeName = sanitizedName(rawName, fallbackExt: ext, index: index)
    let rel = "files/\(index)-\(safeName)"
    let filesDir = dir.appendingPathComponent("files", isDirectory: true)
    try? FileManager.default.createDirectory(at: filesDir, withIntermediateDirectories: true)
    let dest = dir.appendingPathComponent(rel)
    do {
      if FileManager.default.fileExists(atPath: dest.path) {
        try FileManager.default.removeItem(at: dest)
      }
      try FileManager.default.copyItem(at: source, to: dest)
      let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
      let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
      let uti = UTType(filenameExtension: ext) ?? .data
      let kind = forcedKind ?? kindFor(uti)
      let mime = uti.preferredMIMEType ?? "application/octet-stream"
      return StagedAttachment(id: UUID().uuidString, name: safeName, relativePath: rel, mimeType: mime, size: size, kind: kind)
    } catch {
      return nil
    }
  }

  private func sanitizedName(_ raw: String?, fallbackExt: String, index: Int) -> String {
    let base = (raw ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
    if base.isEmpty { return "shared-\(index).\(fallbackExt)" }
    if (base as NSString).pathExtension.isEmpty { return "\(base).\(fallbackExt)" }
    return base
  }
}

// MARK: - SwiftUI Sheet

private struct ShareSheetView: View {
  @ObservedObject var model: ShareViewModel

  var body: some View {
    NavigationStack {
      Form {
        Section("Send to") {
          if model.choices.isEmpty {
            Text("Primary bot (open Botkins once to list all bots)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          } else {
            Picker("Bot", selection: Binding(
              get: { model.selectedChoiceId ?? model.choices.first?.id ?? "" },
              set: { model.selectedChoiceId = $0 }
            )) {
              ForEach(model.choices) { choice in
                let label = model.hasMultipleHosts
                  ? "\(choice.bot.name) · \(choice.hostName)"
                  : (choice.bot.role.isEmpty ? choice.bot.name : "\(choice.bot.name) — \(choice.bot.role)")
                Text(label).tag(choice.id)
              }
            }
            .pickerStyle(.menu)
          }
        }

        Section("Context (optional)") {
          TextField("Add instructions or a note…", text: $model.note, axis: .vertical)
            .lineLimit(3...6)
        }

        Section("Shared items") {
          if model.loading {
            HStack(spacing: 10) {
              ProgressView()
              Text("Preparing shared content…")
                .foregroundStyle(.secondary)
            }
          } else if model.content.urls.isEmpty && model.content.texts.isEmpty && model.content.attachments.isEmpty {
            Text("Nothing attached yet — add a note above or try sharing again.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          } else {
            ForEach(model.content.urls, id: \.self) { link in
              Label(link, systemImage: "link")
                .lineLimit(2)
                .font(.subheadline)
            }
            ForEach(model.content.texts.indices, id: \.self) { idx in
              Label(model.content.texts[idx], systemImage: "text.alignleft")
                .lineLimit(3)
                .font(.subheadline)
            }
            ForEach(model.content.attachments) { file in
              HStack {
                Image(systemName: iconFor(file.kind))
                  .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                  Text(file.name)
                    .font(.subheadline)
                    .lineLimit(1)
                  if file.size > 0 {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                }
              }
            }
          }
        }

        if let err = model.errorMessage {
          Section {
            Text(err)
              .font(.footnote)
              .foregroundStyle(.red)
          }
        }
      }
      .navigationTitle("Share to Botkins")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { model.cancel() }
            .disabled(model.sending)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.sending ? "Opening…" : "Send") { model.send() }
            .fontWeight(.semibold)
            .disabled(!model.canSend)
        }
      }
    }
  }

  private func iconFor(_ kind: String) -> String {
    switch kind {
    case "image": return "photo"
    case "video": return "video"
    default: return "doc"
    }
  }
}
