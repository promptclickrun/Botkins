// Who a Live Activity is about, and what it shows now.
//
// This file exists twice, word for word: in modules/botkins-activity/ios (the app starts and updates
// activities) and in targets/widgets (the extension draws them). Apple matches the two, and a push
// that starts an activity from afar, by the type's name, so keep both copies and the name the same
// (the computer sends it as ACTIVITY_TYPE in link-host/push.mjs).
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

  public init(chatId: String, botId: String, botName: String, head: String, palette: String, eyes: String, colors: [String]) {
    self.chatId = chatId
    self.botId = botId
    self.botName = botName
    self.head = head
    self.palette = palette
    self.eyes = eyes
    self.colors = colors
  }
}
