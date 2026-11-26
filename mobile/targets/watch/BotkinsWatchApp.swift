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

  @State private var showingChat = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 2) {
        Button {
          showingChat = true
        } label: {
          Label("Chat", systemImage: "chevron.down")
            .font(.caption)
        }
        .buttonStyle(.plain)
        Spacer(minLength: 0)
        Header(bot: bot)
        Spacer(minLength: 0)
        VoiceDock()
      }
      .padding(.horizontal, 5)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .contentShape(Rectangle())
      .simultaneousGesture(DragGesture(minimumDistance: 20).onEnded { drag in
        if drag.translation.height > 30 && drag.translation.height > abs(drag.translation.width) {
          showingChat = true
        }
      })
      .navigationDestination(isPresented: $showingChat) {
        if let chat = session.snapshot.chat {
          Conversation(chat: chat)
            .navigationTitle(chat.title)
        } else {
          Text("No chat yet")
        }
      }
    }
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
  let chat: WatchChat

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 6) {
        if chat.messages.isEmpty {
          Text("No messages yet")
            .foregroundStyle(.secondary)
        }
        ForEach(chat.messages) { message in
          MessageBubble(message: message)
        }
        if !chat.activity.isEmpty {
          Text(chat.activity)
            .font(.caption2)
            .foregroundStyle(.orange)
        }
      }
      .padding(.horizontal, 3)
    }
    .defaultScrollAnchor(.bottom, for: .initialOffset)
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
        .fixedSize(horizontal: false, vertical: true)
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
  @State private var showingProblem = false

  private var problem: String? { session.issue ?? voice.problem }

  private var voice: WatchVoice { session.voice }

  var body: some View {
    VStack(spacing: 5) {
      if problem != nil {
        Button("Call details") { showingProblem = true }
          .font(.caption2)
          .buttonStyle(.plain)
      } else {
        Text(session.audioPaused ? "Call paused" : voice.label)
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
        .disabled(!session.reachable || session.snapshot.bot == nil)
      }
    }
    .padding(.top, 3)
    .padding(.bottom, 2)
    .onChange(of: problem, initial: true) { _, value in
      showingProblem = value != nil
    }
    .alert("Watch voice", isPresented: $showingProblem) {
      Button("OK") {}
    } message: {
      Text(problem ?? "")
    }
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
