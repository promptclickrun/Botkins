import AppIntents
import BotkinsActivity
import Expo
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
  if factory.rootViewFactory.reactHost == nil {
    factory.rootViewFactory.initializeReactHost(withLaunchOptions: nil, bundleConfiguration: factory.bundleConfiguration, devMenuConfiguration: factory.devMenuConfiguration ?? .default())
  }
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
struct BotkinsShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: SendBotkinsChat(), phrases: ["Send a chat with \(.applicationName)"], shortTitle: "Send a Botkins Chat", systemImageName: "paperplane")
    AppShortcut(intent: StartBotkinsVoiceChat(), phrases: ["Start a voice chat with \(.applicationName)"], shortTitle: "Start a Voice Chat", systemImageName: "waveform")
  }
}
