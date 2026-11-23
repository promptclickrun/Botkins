import AppIntents
internal import BotkinsActivity
internal import Expo
import React
import UIKit

enum ShortcutError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self { case .message(let text): return text }
  }
}

@MainActor
func runShortcut(_ fields: [String: String]) async throws -> String {
  // Expo normally starts React when a scene connects. Shortcuts can launch the application
  // without a window. Start that same host without a view; a later scene reuses it.
  guard let factory = (UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider)?.reactNativeFactory else {
    throw ShortcutError.message("Open Botkins and try the shortcut again.")
  }
  // A release build has no developer menu: React Native's `defaultConfiguration` is nil there, and
  // force-unwrapping it crashed every shortcut in TestFlight (build 13). React Native itself passes
  // that nil along; Swift can't, so a release build passes an empty configuration, which nothing reads.
  let menu: RCTDevMenuConfiguration = factory.devMenuConfiguration ?? (RCTDevMenuConfiguration.default() as RCTDevMenuConfiguration?) ?? RCTDevMenuConfiguration()
  factory.rootViewFactory.initializeReactHost(launchOptions: nil, bundleConfiguration: factory.bundleConfiguration, devMenuConfiguration: menu)
  return try await ShortcutRequests.run(fields)
}

@available(iOS 17.0, *)
struct SendBotkinsChat: AppIntent {
  static let title: LocalizedStringResource = "Send a Botkins Chat"
  static let description = IntentDescription("Send a prompt in a new chat. Turn on Wait for Result to pass the bot’s reply to the next action.", resultValueName: "Reply")
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

  @Parameter(title: "Prompt", requestValueDialog: "What would you like to send?", inputConnectionBehavior: .connectToPreviousIntentResult)
  var prompt: String
  @Parameter(title: "Agent") var agent: ShortcutAgent
  @Parameter(title: "Model", description: "Leave empty to use the bot’s model.")
  var model: ShortcutModel?
  @Parameter(title: "Thinking Level", optionsProvider: ThinkingLevels()) var effort: String?
  @Parameter(title: "Wait for Result", default: true) var wait: Bool
  @Parameter(title: "Notify Me", default: true) var notify: Bool

  static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$prompt) to \(\.$agent)") {
      \.$model
      \.$effort
      \.$wait
      \.$notify
    }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    var fields = agent.fields
    if let model {
      if let host = fields["host"], host != model.host {
        throw ShortcutError.message("Choose a model from the agent’s computer.")
      }
      fields["modelHost"] = model.host
      fields["model"] = model.key
    }
    fields["action"] = "send"
    fields["prompt"] = prompt
    fields["effort"] = effort
    fields["wait"] = wait ? "yes" : "no"
    fields["notify"] = notify ? "yes" : "no"
    return .result(value: try await runShortcut(fields))
  }
}

struct StartBotkinsVoiceChat: AppIntent {
  static let title: LocalizedStringResource = "Start a Voice Chat"
  static let description = IntentDescription("Open a new chat and start talking with the selected bot.")
  static let openAppWhenRun = true
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

  @Parameter(title: "Agent") var agent: ShortcutAgent
  static var parameterSummary: some ParameterSummary { Summary("Start a voice chat with \(\.$agent)") }

  func perform() async throws -> some IntentResult {
    var fields = agent.fields
    fields["action"] = "voice"
    _ = try await runShortcut(fields)
    return .result()
  }
}

@available(iOS 17.0, *)
struct OpenBotkins: AppIntent {
  static let title: LocalizedStringResource = "Open Botkins"
  static let description = IntentDescription("Open the Botkins app.")
  static let openAppWhenRun = true
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

  func perform() async throws -> some IntentResult {
    .result()
  }
}

@available(iOS 17.0, *)
enum ShortcutChatDestination: String, AppEnum {
  case latest
  case new

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Chat"
  static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .latest: DisplayRepresentation(title: "Latest chat"),
    .new: DisplayRepresentation(title: "New chat"),
  ]
}

@available(iOS 17.0, *)
struct ChatWithYourBotkin: AppIntent {
  static let title: LocalizedStringResource = "Chat with your Botkin"
  static let description = IntentDescription("Open the latest or a new chat with a Botkin on one of your paired computers.")
  static let openAppWhenRun = true
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

  @Parameter(title: "Computer") var computer: ShortcutHost
  @Parameter(title: "Agent") var agent: ShortcutChatAgent
  @Parameter(title: "Chat", default: ShortcutChatDestination.latest) var destination: ShortcutChatDestination

  static var parameterSummary: some ParameterSummary {
    Summary("Chat with \(\.$agent) on \(\.$computer)") {
      \.$destination
    }
  }

  func perform() async throws -> some IntentResult {
    var fields = agent.fields(computer: computer)
    fields["action"] = "open"
    fields["destination"] = destination.rawValue
    _ = try await runShortcut(fields)
    return .result()
  }
}

@available(iOS 17.0, *)
struct BotkinsShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: OpenBotkins(), phrases: ["Open \(.applicationName)"], shortTitle: "Open Botkins", systemImageName: "bubble.left.and.bubble.right")
    AppShortcut(intent: ChatWithYourBotkin(), phrases: ["Chat with my Botkin in \(.applicationName)"], shortTitle: "Chat with your Botkin", systemImageName: "person.bubble")
    AppShortcut(intent: SendBotkinsChat(), phrases: ["Send a chat with \(.applicationName)"], shortTitle: "Send a Botkins Chat", systemImageName: "paperplane")
    AppShortcut(intent: StartBotkinsVoiceChat(), phrases: ["Start a voice chat with \(.applicationName)"], shortTitle: "Start a Voice Chat", systemImageName: "waveform")
  }
}
