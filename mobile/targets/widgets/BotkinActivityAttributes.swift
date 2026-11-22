// Who a Live Activity is about, and what it shows now.
//
// This file exists twice, word for word: in modules/botkins-activity/ios (the app starts and updates
// activities) and in targets/widgets (the extension draws them). Apple matches the two, and a push
// that starts an activity from afar, by the type's name, so keep both copies and the name the same
// (the computer sends it as ACTIVITY_TYPE in link-host/push.mjs).
//
// One activity is a chat's card (`card` is nil; the first version), a Botkin's card (`card` is "bot",
// "activity-bots-v1") or the card for all Botkins (`card` is "all", "activity-all-v1";
// docs/live-cards.md). Everything added since the first version is optional, so a push from an older
// computer, and an activity an older build started, still decode.
import ActivityKit
import Foundation

public struct BotkinActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// thinking, working, waiting, needs-you, done or failed
    public var phase: String
    /// A few words: "Thinking", "Writing", a step's name, "Needs you", "Done".
    public var label: String
    public var steps: Int
    /// When the turn began, in Unix seconds.
    public var startedAt: Double
    /// When the turn ended, in Unix seconds. Missing while it runs, and from a computer that doesn't send it.
    public var finishedAt: Double?

    // A Botkin's card ("activity-bots-v1"):
    /// The shape's version (1).
    public var v: Int?
    /// Up to three of the Botkin's chats, as Apple may see them: phases, counts, times, the provider.
    public var chats: [Chat]?
    /// How many more chats there are than the card shows.
    public var more: Int?
    /// The chats' titles, steps, thinking and requests, sealed for this phone (opened by the extension).
    public var sealed: String?
    /// Set on the phone only, when the person answered on the card: the answer's words, until the computer's next update.
    public var sent: String?

    public struct Chat: Codable, Hashable {
      public var id: String
      public var phase: String
      public var steps: Int
      public var startedAt: Double
      public var finishedAt: Double?
      public var provider: String?
      /// approve, risky, question or open: what the card's buttons are.
      public var ask: String?
      // On the card for all Botkins: the chat's Botkin, and its look when the computer has one saved.
      public var bot: String?
      public var head: String?
      public var palette: String?
      public var eyes: String?
      public var colors: [String]?
    }

    public init(phase: String, label: String, steps: Int, startedAt: Double, finishedAt: Double? = nil) {
      self.phase = phase
      self.label = label
      self.steps = steps
      self.startedAt = startedAt
      self.finishedAt = finishedAt
    }
  }

  public var chatId: String
  public var botId: String
  public var botName: String
  /// The bot's Botkin: its character, palette, eyes and (for a custom palette) its four colors.
  public var head: String
  public var palette: String
  public var eyes: String
  public var colors: [String]
  /// "bot" for a Botkin's card, "all" for the card for all Botkins. Missing on a chat's card.
  public var card: String?

  public init(chatId: String, botId: String, botName: String, head: String, palette: String, eyes: String, colors: [String], card: String? = nil) {
    self.chatId = chatId
    self.botId = botId
    self.botName = botName
    self.head = head
    self.palette = palette
    self.eyes = eyes
    self.colors = colors
    self.card = card
  }

  /// The key the app and the computer know this activity by: the chat's id, "bot:" and the Botkin's, or "all".
  public var key: String { card == "all" ? "all" : card == "bot" ? "bot:" + botId : chatId }
}
