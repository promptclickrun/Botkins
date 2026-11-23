import SwiftUI

@main
struct BotkinsWatchApp: App {
  @StateObject private var session = WatchSession()

  var body: some Scene {
    WindowGroup {
      WatchHome()
        .environmentObject(session)
    }
  }
}

struct WatchHome: View {
  @EnvironmentObject private var session: WatchSession

  var body: some View {
    Group {
      if let bot = session.snapshot.bot {
        ConversationView(bot: bot)
      } else {
        VStack(spacing: 10) {
          Image(systemName: "iphone.gen2")
            .font(.system(size: 34))
            .foregroundStyle(.orange)
          Text("Open Botkins")
            .font(.headline)
          Text(session.snapshot.computer == nil ? "Pair with a computer on your iPhone." : "The primary Botkin is loading.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          Button("Refresh") { session.refresh() }
            .buttonStyle(.bordered)
        }
        .padding()
      }
    }
    .task { session.refresh() }
  }
}

private struct ConversationView: View {
  @EnvironmentObject private var session: WatchSession
  let bot: WatchBot

  var body: some View {
    VStack(spacing: 0) {
      Header(bot: bot)
      if let chat = session.snapshot.chat {
        Conversation(chat: chat)
      } else {
        Spacer()
        Text("No chat yet")
          .font(.headline)
        Text("Start a voice chat with \(bot.name).")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal)
        Spacer()
      }
      VoiceDock()
    }
    .padding(.horizontal, 5)
  }
}

private struct Header: View {
  @EnvironmentObject private var session: WatchSession
  let bot: WatchBot

  var body: some View {
    HStack(spacing: 8) {
      Button {
        if session.voice.status == "talking" { session.interrupt() }
        else { session.refresh() }
      } label: {
        BotkinFace(look: bot.look, size: 38, talking: session.voice.status == "talking")
      }
      .buttonStyle(.plain)
      .accessibilityLabel(session.voice.status == "talking" ? "Interrupt \(bot.name)" : "Refresh \(bot.name)")
      VStack(alignment: .leading, spacing: 1) {
        Text(bot.name).font(.headline).lineLimit(1)
        Text(session.snapshot.computer?.name ?? "Phone unavailable")
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 2)
      Circle()
        .fill(session.reachable && session.snapshot.computer?.online == true ? Color.green : Color.secondary)
        .frame(width: 6, height: 6)
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 3)
  }
}

private struct Conversation: View {
  @EnvironmentObject private var session: WatchSession
  let chat: WatchChat

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(chat.title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 6)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(chat.messages) { message in
              MessageBubble(message: message)
                .id(message.id)
            }
          }
          .padding(.horizontal, 2)
          .padding(.bottom, 6)
        }
        .onChange(of: chat.messages.count) {
          if let id = chat.messages.last?.id {
            withAnimation { proxy.scrollTo(id, anchor: .bottom) }
          }
        }
      }
      if !chat.activity.isEmpty {
        Text(chat.activity)
          .font(.caption2)
          .foregroundStyle(.orange)
          .padding(.horizontal, 7)
      }
    }
  }
}

private struct MessageBubble: View {
  let message: WatchMessage

  var body: some View {
    HStack {
      if message.who == "you" { Spacer(minLength: 22) }
      Text(message.text)
        .font(.footnote)
        .foregroundStyle(message.final ? .primary : .secondary)
        .lineLimit(5)
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(message.who == "you" ? Color.orange.opacity(0.22) : Color.white.opacity(0.075))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      if message.who != "you" { Spacer(minLength: 18) }
    }
  }
}

private struct VoiceDock: View {
  @EnvironmentObject private var session: WatchSession
  @State private var holding = false

  private var voice: WatchVoice { session.voice }

  var body: some View {
    VStack(spacing: 5) {
      if let problem = session.issue ?? voice.problem {
        Text(problem)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
          .multilineTextAlignment(.center)
      } else {
        Text(voice.label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(voice.status == "talking" ? .orange : .secondary)
          .lineLimit(1)
      }

      if voice.active {
        HStack(spacing: 7) {
          Button {
            session.mute(!voice.muted)
          } label: {
            Image(systemName: voice.muted ? "mic.slash.fill" : "mic.fill")
          }
          .buttonStyle(.bordered)
          .tint(voice.muted ? .gray : .blue)
          .frame(width: 40)

          if voice.push {
            PressToTalk(holding: $holding)
              .frame(maxWidth: .infinity)
          } else {
            Wave(level: voice.level, active: voice.status == "talking")
              .frame(maxWidth: .infinity)
          }

          Button(role: .destructive) {
            session.endVoice()
          } label: {
            Image(systemName: "phone.down.fill")
          }
          .buttonStyle(.bordered)
          .frame(width: 40)
        }
      } else {
        Button {
          session.startVoice()
        } label: {
          Label("Talk to \(session.snapshot.bot?.name ?? "Botkin")", systemImage: "mic.fill")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(.orange)
        .disabled(!session.reachable || session.snapshot.bot == nil || session.snapshot.computer?.online != true)
      }
    }
    .padding(.top, 3)
    .padding(.bottom, 2)
  }
}

private struct Wave: View {
  let level: Double
  let active: Bool
  private let heights: [CGFloat] = [5, 12, 20, 10, 17, 7]

  var body: some View {
    HStack(spacing: 2) {
      ForEach(heights.indices, id: \.self) { index in
        RoundedRectangle(cornerRadius: 2)
          .fill(active ? Color.orange : Color.gray)
          .frame(width: 3, height: max(3, heights[index] * CGFloat(0.3 + level)))
      }
    }
    .frame(height: 22)
  }
}

private struct PressToTalk: View {
  @EnvironmentObject private var session: WatchSession
  @Binding var holding: Bool

  var body: some View {
    Text(holding ? "Speaking..." : "Hold to talk")
      .font(.caption2.weight(.semibold))
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity)
      .background(holding ? Color.orange : Color.white.opacity(0.09))
      .foregroundStyle(holding ? .black : .primary)
      .clipShape(Capsule())
      .onLongPressGesture(minimumDuration: 0, maximumDistance: 80, pressing: { pressing in
        guard pressing != holding else { return }
        holding = pressing
        if pressing { session.talkDown() } else { session.talkUp() }
      }, perform: {})
  }
}
