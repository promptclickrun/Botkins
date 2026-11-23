import AppIntents
import Foundation

/// Only labels and stable IDs are returned to the picker. Host IDs keep saved shortcuts bound
/// to the right pairing when two computers have identically named agents or models.
private struct Catalog: Decodable {
  struct Bot: Decodable { let id, name: String; let model: String? }
  struct Model: Decodable { let key, name, provider, label: String; let efforts: [String] }
  let host, name: String
  let bots: [Bot]
  let models: [Model]

  static func load(host: String? = nil, models: Bool = false) async throws -> Self {
    var fields = ["action": "catalog", "models": models ? "yes" : "no"]
    fields["host"] = host
    let json = try await runShortcut(fields)
    return try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

private func hosts(in identifiers: [String]) -> Set<String> {
  Set(identifiers.compactMap { id in id.firstIndex(of: "|").map { String(id[..<$0]) } })
}

@available(iOS 17.0, *)
struct ShortcutHost: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Computer"
  static let defaultQuery = HostQuery()
  static let current = Self(id: "current", name: "Current computer")
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", image: .init(systemName: "desktopcomputer"))
  }
  var fields: [String: String] { id == Self.current.id ? [:] : ["host": id] }

  struct HostQuery: EntityQuery {
    private func load() async throws -> [ShortcutHost] {
      let json = try await runShortcut(["action": "hosts"])
      struct Item: Decodable { let id, name: String }
      let items = try JSONDecoder().decode([Item].self, from: Data(json.utf8))
      return items.map { ShortcutHost(id: $0.id, name: $0.name) }
    }
    func defaultResult() async -> ShortcutHost? { .current }
    func suggestedEntities() async throws -> [ShortcutHost] {
      let listed = try await load()
      return [.current] + listed
    }
    func entities(for identifiers: [String]) async throws -> [ShortcutHost] {
      let options = [.current] + (try await load())
      return try identifiers.map { id in
        guard let host = options.first(where: { $0.id == id }) else {
          throw ShortcutError.message("Choose a computer that is still paired in Botkins.")
        }
        return host
      }
    }
  }
}

@available(iOS 17.0, *)
struct ShortcutChatAgent: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Botkin"
  static let defaultQuery = ChatAgentQuery()
  static let primary = Self(id: "primary", name: "Primary Botkin")
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", image: .init(systemName: "person.crop.circle"))
  }

  func fields(computer: ShortcutHost) -> [String: String] {
    var fields = computer.fields
    if let split = id.firstIndex(of: "|") {
      fields["botHost"] = String(id[..<split])
      fields["bot"] = String(id[id.index(after: split)...])
    }
    return fields
  }

  struct ChatAgentQuery: EntityQuery {
    @IntentParameterDependency<ChatWithYourBotkin>(\.$computer) var intent
    private func host() -> String? {
      guard let id = intent?.computer.id, id != ShortcutHost.current.id else { return nil }
      return id
    }
    private func agents(on host: String?) async throws -> [ShortcutChatAgent] {
      let catalog = try await Catalog.load(host: host)
      return catalog.bots.map { ShortcutChatAgent(id: catalog.host + "|" + $0.id, name: $0.name) }
    }
    func defaultResult() async -> ShortcutChatAgent? { .primary }
    func suggestedEntities() async throws -> [ShortcutChatAgent] {
      let listed = try await agents(on: host())
      return [.primary] + listed
    }
    func entities(for identifiers: [String]) async throws -> [ShortcutChatAgent] {
      var options: [ShortcutChatAgent] = [.primary]
      for host in hosts(in: identifiers) { options += try await agents(on: host) }
      return try identifiers.map { id in
        guard let agent = options.first(where: { $0.id == id }) else {
          throw ShortcutError.message("Choose a Botkin that is still available on the selected computer.")
        }
        return agent
      }
    }
  }
}

struct ShortcutAgent: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
  static let defaultQuery = AgentQuery()
  static let primary = Self(id: "primary", name: "Primary bot", computer: nil)
  let id: String
  let name: String
  let computer: String?
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: computer.map { "\($0)" }, image: .init(systemName: "person.crop.circle"))
  }
  var fields: [String: String] {
    guard let split = id.firstIndex(of: "|") else { return [:] }
    return ["host": String(id[..<split]), "bot": String(id[id.index(after: split)...])]
  }

  struct AgentQuery: EntityQuery {
    private func agents(_ catalog: Catalog) -> [ShortcutAgent] {
      catalog.bots.map { ShortcutAgent(id: catalog.host + "|" + $0.id, name: $0.name, computer: catalog.name) }
    }
    func defaultResult() async -> ShortcutAgent? { .primary }
    func suggestedEntities() async throws -> [ShortcutAgent] {
      let catalog = try await Catalog.load()
      let primary = ShortcutAgent(id: "primary", name: "Primary bot", computer: catalog.bots.first?.name)
      return [primary] + agents(catalog)
    }
    func entities(for identifiers: [String]) async throws -> [ShortcutAgent] {
      var options: [ShortcutAgent] = [.primary]
      for host in hosts(in: identifiers) { options += agents(try await Catalog.load(host: host)) }
      return try identifiers.map { id in
        guard let agent = options.first(where: { $0.id == id }) else { throw ShortcutError.message("Choose an available agent in the shortcut.") }
        return agent
      }
    }
  }
}

@available(iOS 17.0, *)
struct ShortcutModel: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Model"
  static let defaultQuery = ModelQuery()
  let host: String
  let key: String
  let name: String
  let provider: String
  let label: String
  let efforts: [String]
  var id: String { host + "|" + key }
  var displayRepresentation: DisplayRepresentation {
    let aliases = ["claudeAgent": "claude", "anthropic": "claude", "openai": "codex", "chatgpt": "codex", "github": "copilot"]
    let mark = aliases[provider] ?? provider
    var image = DisplayRepresentation.Image(systemName: "cpu")
    if let url = Bundle.main.url(forResource: "provider-" + mark, withExtension: "png"),
       let data = try? Data(contentsOf: url) {
      image = .init(data: data, isTemplate: !["claude", "kiro", "antigravity"].contains(mark))
    }
    return DisplayRepresentation(title: "\(name)", subtitle: "\(label)", image: image)
  }

  struct ModelQuery: EntityQuery {
    @IntentParameterDependency<SendBotkinsChat>(\.$agent) var intent
    private func models(_ catalog: Catalog) -> [ShortcutModel] {
      catalog.models.map { ShortcutModel(host: catalog.host, key: $0.key, name: $0.name, provider: $0.provider, label: $0.label, efforts: $0.efforts) }
    }
    func suggestedEntities() async throws -> [ShortcutModel] {
      models(try await Catalog.load(host: intent?.agent.fields["host"], models: true))
    }
    func entities(for identifiers: [String]) async throws -> [ShortcutModel] {
      var options: [ShortcutModel] = []
      for host in hosts(in: identifiers) { options += models(try await Catalog.load(host: host, models: true)) }
      return try identifiers.map { id in
        guard let model = options.first(where: { $0.id == id }) else { throw ShortcutError.message("Choose an available model in the shortcut.") }
        return model
      }
    }
  }
}

@available(iOS 17.0, *)
struct ThinkingLevels: DynamicOptionsProvider {
  @IntentParameterDependency<SendBotkinsChat>(\.$agent, \.$model) var intent
  func results() async throws -> ItemCollection<String> {
    let levels: [String]
    if let model = intent?.model {
      levels = model.efforts
    } else {
      let agent = intent?.agent.fields ?? [:]
      let catalog = try await Catalog.load(host: agent["host"], models: true)
      let bot = agent["bot"].map { id in catalog.bots.first { $0.id == id } } ?? catalog.bots.first
      levels = catalog.models.first { $0.key == bot?.model }?.efforts ?? []
    }
    return ItemCollection(sections: [ItemSection(items: levels.map { level in
      let label = level == "xhigh" ? "Extra high" : level.capitalized
      return Item(level, title: "\(label)")
    })])
  }
}
