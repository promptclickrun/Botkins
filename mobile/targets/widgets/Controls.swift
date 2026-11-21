// The controls (iOS 18): a Botkin in Control Center, at the bottom of the Lock Screen or on the
// Action button. A press opens its last chat, a new chat, or talking with it, as the control was
// set up. A control shows only a symbol, so each Botkin has its outline as one ("botkin.<head>",
// scripts/botkin-symbols.py).
import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct BotkinControlConfiguration: ControlConfigurationIntent {
  static let title: LocalizedStringResource = "Botkin"
  @Parameter(title: "Botkin") var botkin: BotkinEntity?
  @Parameter(title: "Opens", default: .last) var opens: BotkinOpens
}

@available(iOS 18.0, *)
struct OpenBotkinIntent: AppIntent {
  static let title: LocalizedStringResource = "Open a Botkin"
  static let isDiscoverable = false
  @Parameter(title: "Botkin") var botkin: BotkinEntity?
  @Parameter(title: "Opens", default: .last) var opens: BotkinOpens

  init() {}

  init(botkin: BotkinEntity?, opens: BotkinOpens) {
    self.botkin = botkin
    self.opens = opens
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    let parts = (botkin?.id ?? "").split(separator: "|", maxSplits: 1).map(String.init)
    let url = parts.count == 2 ? Links.bot(parts[1], host: parts[0], opens: opens.rawValue) : URL(string: "botkins://")!
    return .result(opensIntent: OpenURLIntent(url))
  }
}

@available(iOS 18.0, *)
struct BotkinControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: "BotkinsControl", intent: BotkinControlConfiguration.self) { configuration in
      ControlWidgetButton(action: OpenBotkinIntent(botkin: configuration.botkin, opens: configuration.opens)) {
        Label(title(configuration), image: "botkin." + (configuration.botkin?.head ?? "pip"))
      }
    }
    .displayName("Botkin")
    .description("Opens one Botkin.")
  }

  private func title(_ configuration: BotkinControlConfiguration) -> String {
    let name = configuration.botkin?.name ?? "Botkin"
    switch configuration.opens {
    case .talk: return "Talk to " + name
    case .new: return "New chat with " + name
    case .last: return name
    }
  }
}
