import ExpoModulesCore
import UIKit

private final class EmojiField: UITextField {
  override var textInputContextIdentifier: String? { "botkins.reaction" }
  override var textInputMode: UITextInputMode? {
    UITextInputMode.activeInputModes.first { $0.primaryLanguage == "emoji" } ?? super.textInputMode
  }
}

final class ReactionInput: ExpoView {
  let onChange = EventDispatcher()
  private let field = EmojiField()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    field.accessibilityLabel = "Reaction emoji"
    field.font = .preferredFont(forTextStyle: .title2)
    field.textAlignment = .center
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    addSubview(field)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    field.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.window != nil else { return }
      self.field.becomeFirstResponder()
    }
  }

  @objc private func changed() { onChange(["text": field.text ?? ""]) }
}

public final class BotkinsEmojiModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BotkinsEmoji")
    View(ReactionInput.self) { Events("onChange") }
  }
}
