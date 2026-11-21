import ExpoModulesCore
import UIKit

// The pose of a folding iPhone (iPhone Duo, iOS 27.1) for the app's layout: the hinge (closed,
// partly open, open, with its angle), the band the fold takes on the inner display (the "division"
// reserved region, in window points), and which edge holds the vertical bar (the side rail the
// system moves the status bar, toolbar and tab bar into). A phone without a hinge reports
// `hinge: nil` and no fold; before iOS 27.1 nothing is reported at all.
//
// Read once with `state()`; while JavaScript listens, "changed" carries every change.
public final class BotkinsFoldModule: Module {
  private var watcher: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("BotkinsFold")
    Events("changed")

    Function("available") { () -> Bool in
      if #available(iOS 27.1, *) { return true }
      return false
    }

    AsyncFunction("state") { () -> [String: Any] in
      // Runs on the main queue (runOnQueue below); the windows and the watcher are the main actor's.
      MainActor.assumeIsolated {
        if #available(iOS 27.1, *) {
          return (self.watcher as? FoldWatcher)?.last ?? FoldWatcher.read(FoldWatcher.keyWindow(), hinge: nil)
        }
        return ["hinge": NSNull(), "edge": NSNull(), "fold": NSNull()]
      }
    }.runOnQueue(.main)

    OnStartObserving {
      Task { @MainActor in
        guard #available(iOS 27.1, *), self.watcher == nil else { return }
        let watcher = FoldWatcher { [weak self] state in self?.sendEvent("changed", state) }
        self.watcher = watcher
        watcher.start()
      }
    }

    OnStopObserving {
      Task { @MainActor in
        if #available(iOS 27.1, *) { (self.watcher as? FoldWatcher)?.stop() }
        self.watcher = nil
      }
    }
  }
}

@available(iOS 27.1, *)
@MainActor
final class FoldWatcher {
  private let send: ([String: Any]) -> Void
  private weak var window: UIWindow?
  private var interaction: UIHingeInteraction?
  private var traits: UITraitChangeRegistration?
  private var observers: [NSObjectProtocol] = []
  private var hinge: UIHinge?
  private var said = ""
  var last: [String: Any]?

  init(send: @escaping ([String: Any]) -> Void) {
    self.send = send
  }

  static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap(\.windows)
    return windows.first(where: \.isKeyWindow) ?? windows.first
  }

  static func read(_ window: UIWindow?, hinge: UIHinge?) -> [String: Any] {
    guard let window else { return ["hinge": NSNull(), "edge": NSNull(), "fold": NSNull()] }
    // The bar's edge is resolved for the content, so read it from the root view controller.
    let traits = window.rootViewController?.traitCollection ?? window.traitCollection
    let edge: Any = switch traits.verticalBarEdge {
    case .leading: "leading"
    case .trailing: "trailing"
    default: NSNull()
    }
    var state: [String: Any] = ["edge": edge]
    if let hinge {
      let status = switch hinge.status {
      case .closed: "closed"
      case .partiallyOpen: "partial"
      case .fullyOpen: "open"
      default: "unknown"
      }
      state["hinge"] = status
      state["angle"] = Double(hinge.angle)
    } else {
      state["hinge"] = NSNull()
    }
    // The division region is where the inner display folds. Keep taps and text out of it.
    if let region = window.reservedRegions(kind: .division).first(where: \.isActive) {
      let frame = region.frame
      state["fold"] = ["x": Double(frame.minX), "y": Double(frame.minY), "width": Double(frame.width), "height": Double(frame.height)]
    } else {
      state["fold"] = NSNull()
    }
    return state
  }

  func start() {
    attach()
    // The scene may connect after JavaScript starts listening, and a fold can swap windows.
    for name in [UIWindow.didBecomeKeyNotification, UIScene.didActivateNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.attach() }
      })
    }
  }

  func stop() {
    if let interaction, let window { window.removeInteraction(interaction) }
    if let traits, let window { window.unregisterForTraitChanges(traits) }
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    interaction = nil
    traits = nil
  }

  private func attach() {
    guard let next = Self.keyWindow() else { return }
    if next !== window {
      if let interaction, let window { window.removeInteraction(interaction) }
      if let traits, let window { window.unregisterForTraitChanges(traits) }
      window = next
      let interaction = UIHingeInteraction { [weak self] _, update in
        MainActor.assumeIsolated {
          self?.hinge = update.hinge
          self?.report()
        }
      }
      next.addInteraction(interaction)
      self.interaction = interaction
      let watched = UITraitCollection.systemTraitsAffectingVerticalBarEdge + [UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]
      traits = next.registerForTraitChanges(watched) { [weak self] (_: UIWindow, _: UITraitCollection) in
        // The fold's region follows the new layout a moment later.
        DispatchQueue.main.async { self?.report() }
      }
    }
    report()
  }

  private func report() {
    let state = Self.read(window, hinge: hinge)
    let key = String(describing: state.sorted { $0.key < $1.key })
    last = state
    guard key != said else { return }
    said = key
    send(state)
  }
}
