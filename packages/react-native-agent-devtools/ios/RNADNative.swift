import UIKit

/// UIKit side of react-native-agent-devtools.
///
/// Only public UIKit APIs are used. In particular there is no touch synthesis:
/// iOS offers no public API to inject touches into the app's own process, so taps
/// on React Native pressables are performed semantically by the JS executor and
/// verified here with a real `UIView.hitTest` instead.
///
/// Every entry point is called on the main queue (see `methodQueue` in RNAgentDevTools.mm).
@objc(RNADNative)
public final class RNADNative: NSObject {

  public typealias Resolve = (Any?) -> Void
  public typealias Reject = (String, String) -> Void

  // MARK: - Environment

  @objc public static var isDebuggable: Bool {
    #if DEBUG
    return true
    #else
    return false
    #endif
  }

  @objc public static var isEmulator: Bool {
    #if targetEnvironment(simulator)
    return true
    #else
    return false
    #endif
  }

  /// Hardware identifier (e.g. "iPhone17,1"); never the user-assigned device name.
  @objc public static var modelIdentifier: String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
    var info = utsname()
    uname(&info)
    let mirror = Mirror(reflecting: info.machine)
    return mirror.children.reduce(into: "") { acc, el in
      if let v = el.value as? Int8, v != 0 { acc.append(Character(UnicodeScalar(UInt8(v)))) }
    }
  }

  @objc public static var osVersion: String { UIDevice.current.systemVersion }

  @objc public static var appName: String {
    let b = Bundle.main
    return (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
      ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? ""
  }

  @objc public static var bundleId: String { Bundle.main.bundleIdentifier ?? "" }

  // MARK: - Private storage (pairing token)

  private static let keychainService = "react-native-agent-devtools"

  private static func keychainQuery(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: key]
  }

  @objc(rnadStoredValueForKey:) public static func rnadStoredValue(forKey key: String) -> String? {
    var query = keychainQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// An empty value removes the entry. Stored for this device only, never synced or backed up.
  @objc(rnadSetStoredValue:forKey:) public static func rnadSetStoredValue(_ value: String, forKey key: String) -> Bool {
    SecItemDelete(keychainQuery(key) as CFDictionary)
    if value.isEmpty { return true }
    var item = keychainQuery(key)
    item[kSecValueData as String] = Data(value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  // MARK: - Windows and views

  static func appWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState != .unattached && $0.activationState != .background }
      .flatMap { $0.windows }
      .filter { !$0.isHidden && $0.alpha > 0.01 }
      .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
  }

  static func keyWindow() -> UIWindow? {
    let windows = appWindows()
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first
  }

  private static let componentViewProtocol: Protocol? = NSProtocolFromString("RCTComponentViewProtocol")

  /// Fabric component views carry their React tag in `UIView.tag` (set by RCTComponentViewRegistry).
  static func isReactView(_ v: UIView) -> Bool {
    guard v.tag > 0 else { return false }
    if let p = componentViewProtocol { return v.conforms(to: p) }
    return NSStringFromClass(type(of: v)).hasPrefix("RCT")
  }

  /// One traversal of every app window: tag -> view. O(views).
  static func tagMap() -> [Int: UIView] {
    var map: [Int: UIView] = [:]
    func visit(_ v: UIView) {
      if isReactView(v), map[v.tag] == nil { map[v.tag] = v }
      for s in v.subviews { visit(s) }
    }
    for w in appWindows() { visit(w) }
    return map
  }

  static func view(forTag tag: Int) -> UIView? {
    for w in appWindows() {
      if let v = w.viewWithTag(tag), isReactView(v) { return v }
    }
    return nil
  }

  static func isShown(_ v: UIView) -> Bool {
    guard v.window != nil else { return false }
    var cur: UIView? = v
    while let c = cur {
      if c.isHidden || c.alpha < 0.01 { return false }
      cur = c.superview
    }
    return true
  }

  static func nearestReactTag(_ v: UIView?) -> Int {
    var cur = v
    while let c = cur {
      if isReactView(c) { return c.tag }
      cur = c.superview
    }
    return 0
  }

  /// The view a real touch at `point` (screen coordinates) would be delivered to.
  static func hitView(atScreenPoint point: CGPoint) -> UIView? {
    for w in appWindows().reversed() where w.isUserInteractionEnabled {
      let wp = w.convert(point, from: nil)
      if let hit = w.hitTest(wp, with: nil) { return hit }
    }
    return nil
  }

  // MARK: - Probe

  @objc(probeWithTags:offsets:resolve:)
  public static func probe(tags: [NSNumber], offsets: [NSNumber], resolve: Resolve) {
    let map = tagMap()
    var shown: [Bool] = []
    var hits: [Int] = []
    shown.reserveCapacity(tags.count)
    hits.reserveCapacity(tags.count)
    for (i, t) in tags.enumerated() {
      guard let v = map[t.intValue] else {
        shown.append(false)
        hits.append(-1)
        continue
      }
      let visible = isShown(v)
      shown.append(visible)
      let dx = 2 * i < offsets.count ? offsets[2 * i].doubleValue : -1
      let dy = 2 * i + 1 < offsets.count ? offsets[2 * i + 1].doubleValue : -1
      if !visible || dx < 0 || dy < 0 {
        hits.append(-1)
        continue
      }
      let windowPoint = v.convert(CGPoint(x: dx, y: dy), to: nil)
      let screenPoint = v.window?.convert(windowPoint, to: nil) ?? windowPoint
      hits.append(nearestReactTag(hitView(atScreenPoint: screenPoint)))
    }
    resolve(["shown": shown, "hit": hits])
  }

  // MARK: - Actions

  private static func firstDescendant<T: UIView>(of v: UIView, as type: T.Type, maxDepth: Int = 4) -> T? {
    if let t = v as? T { return t }
    guard maxDepth > 0 else { return nil }
    for s in v.subviews {
      if let t = firstDescendant(of: s, as: type, maxDepth: maxDepth - 1) { return t }
    }
    return nil
  }

  @objc(tapWithTag:resolve:reject:)
  public static func tap(tag: Int, resolve: Resolve, reject: Reject) {
    guard let v = view(forTag: tag) else { return reject("RNAD_NOT_FOUND", "No native view for tag \(tag)") }
    if let sw = firstDescendant(of: v, as: UISwitch.self) {
      guard sw.isEnabled else { return reject("RNAD_DISABLED", "UISwitch is disabled") }
      sw.setOn(!sw.isOn, animated: true)
      sw.sendActions(for: .valueChanged)
      return resolve(["mode": "native", "control": "UISwitch", "value": sw.isOn])
    }
    if let button = firstDescendant(of: v, as: UIButton.self, maxDepth: 1) {
      guard button.isEnabled else { return reject("RNAD_DISABLED", "UIButton is disabled") }
      button.sendActions(for: .touchUpInside)
      return resolve(["mode": "native", "control": "UIButton"])
    }
    reject("RNAD_UNSUPPORTED", "iOS has no public API to inject touches in-process; use a semantic tap or an OS-level backend")
  }

  @objc(typeTextWithTag:text:replace:submit:resolve:reject:)
  public static func typeText(tag: Int, text: String, replace: Bool, submit: Bool, resolve: Resolve, reject: Reject) {
    guard let v = view(forTag: tag) else { return reject("RNAD_NOT_FOUND", "No native view for tag \(tag)") }
    let input: (UIView & UITextInput)? =
      firstDescendant(of: v, as: UITextField.self) ?? firstDescendant(of: v, as: UITextView.self)
    guard let field = input else { return reject("RNAD_NOT_TEXT_INPUT", "View \(tag) contains no text input") }
    if let tf = field as? UITextField, !tf.isEnabled { return reject("RNAD_DISABLED", "Text field is disabled") }
    if let tv = field as? UITextView, !tv.isEditable { return reject("RNAD_DISABLED", "Text view is not editable") }

    if !field.isFirstResponder { field.becomeFirstResponder() }
    if replace {
      if let all = field.textRange(from: field.beginningOfDocument, to: field.endOfDocument) {
        field.selectedTextRange = all
      }
      if text.isEmpty, field.hasText { field.deleteBackward() }
    }
    if !text.isEmpty { field.insertText(text) }

    var submitted = false
    if submit {
      if let tf = field as? UITextField {
        submitted = tf.delegate?.textFieldShouldReturn?(tf) ?? false
      } else {
        field.insertText("\n")
        submitted = true
      }
    }

    let current: String = (field as? UITextField)?.text ?? (field as? UITextView)?.text ?? ""
    let secure = (field as? UITextField)?.isSecureTextEntry ?? false
    var result: [String: Any] = ["mode": "native", "length": current.count, "secure": secure, "submitted": submitted]
    if !secure { result["value"] = current }
    resolve(result)
  }

  @objc(scrollByTag:dx:dy:animated:resolve:reject:)
  public static func scrollBy(tag: Int, dx: Double, dy: Double, animated: Bool, resolve: Resolve, reject: Reject) {
    guard let v = view(forTag: tag) else { return reject("RNAD_NOT_FOUND", "No native view for tag \(tag)") }
    guard let sv = firstDescendant(of: v, as: UIScrollView.self) else {
      return reject("RNAD_NOT_SCROLLABLE", "View \(tag) contains no UIScrollView")
    }
    let inset = sv.adjustedContentInset
    let minX = -inset.left, minY = -inset.top
    let maxX = max(minX, sv.contentSize.width - sv.bounds.width + inset.right)
    let maxY = max(minY, sv.contentSize.height - sv.bounds.height + inset.bottom)
    let before = sv.contentOffset
    let target = CGPoint(
      x: min(max(before.x + dx, minX), maxX),
      y: min(max(before.y + dy, minY), maxY)
    )
    sv.setContentOffset(target, animated: animated)
    resolve([
      "mode": "native",
      "before": ["x": before.x, "y": before.y],
      "after": ["x": target.x, "y": target.y],
      "max": ["x": maxX, "y": maxY],
      "viewport": ["width": sv.bounds.width, "height": sv.bounds.height],
      "moved": abs(target.x - before.x) > 0.5 || abs(target.y - before.y) > 0.5,
    ])
  }

  // MARK: - Screenshot

  @objc(captureWithMaxWidth:quality:boxes:labels:resolve:reject:)
  public static func capture(maxWidth: Double, quality: Double, boxes: [NSNumber], labels: [String], resolve: Resolve, reject: Reject) {
    guard let key = keyWindow() else { return reject("RNAD_NO_WINDOW", "No visible window") }
    let started = CACurrentMediaTime()
    let bounds = key.screen.bounds
    let format = UIGraphicsImageRendererFormat()
    let nativeScale = key.screen.scale
    format.scale = maxWidth > 0 ? min(nativeScale, maxWidth / bounds.width) : nativeScale
    format.opaque = true

    let windows = appWindows().filter {
      let name = NSStringFromClass(type(of: $0))
      return !name.contains("Keyboard") && !name.contains("TextEffects")
    }
    let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { ctx in
      UIColor.systemBackground.setFill()
      ctx.fill(bounds)
      for w in windows {
        w.drawHierarchy(in: w.convert(w.bounds, to: nil), afterScreenUpdates: false)
      }
      drawBoxes(boxes, labels: labels, in: ctx.cgContext)
    }
    let png = quality >= 1
    guard let data = png ? image.pngData() : image.jpegData(compressionQuality: CGFloat(max(0.1, quality))) else {
      return reject("RNAD_ENCODE_FAILED", "Could not encode screenshot")
    }
    resolve([
      "data": data.base64EncodedString(),
      "mimeType": png ? "image/png" : "image/jpeg",
      "width": Int((bounds.width * format.scale).rounded()),
      "height": Int((bounds.height * format.scale).rounded()),
      "pointWidth": bounds.width,
      "pointHeight": bounds.height,
      "scale": format.scale,
      "captureMs": (CACurrentMediaTime() - started) * 1000,
    ])
  }

  private static func drawBoxes(_ boxes: [NSNumber], labels: [String], in cg: CGContext) {
    guard boxes.count >= 4 else { return }
    let stroke = UIColor(red: 0.85, green: 0.35, blue: 0.2, alpha: 0.95)
    let font = UIFont.monospacedSystemFont(ofSize: 10, weight: .bold)
    for i in stride(from: 0, to: boxes.count - 3, by: 4) {
      let r = CGRect(x: boxes[i].doubleValue, y: boxes[i + 1].doubleValue,
                     width: boxes[i + 2].doubleValue, height: boxes[i + 3].doubleValue)
      cg.setStrokeColor(stroke.cgColor)
      cg.setLineWidth(1.5)
      cg.stroke(r)
      let idx = i / 4
      guard idx < labels.count else { continue }
      let text = labels[idx] as NSString
      let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
      let size = text.size(withAttributes: attrs)
      let tagRect = CGRect(x: r.minX, y: max(0, r.minY - size.height - 2), width: size.width + 4, height: size.height + 2)
      cg.setFillColor(stroke.cgColor)
      cg.fill(tagRect)
      text.draw(at: CGPoint(x: tagRect.minX + 2, y: tagRect.minY + 1), withAttributes: attrs)
    }
  }

  // MARK: - Misc

  @objc public static func safeAreaInsets() -> [String: Double] {
    let i = keyWindow()?.safeAreaInsets ?? .zero
    return ["top": i.top, "bottom": i.bottom, "left": i.left, "right": i.right]
  }

  /// Native alerts are invisible to the React tree; report them read-only.
  @objc public static func nativeOverlays() -> [String: Any] {
    var overlays: [[String: Any]] = []
    for w in appWindows() {
      var vc = w.rootViewController
      while let presented = vc?.presentedViewController {
        if let alert = presented as? UIAlertController {
          overlays.append([
            "type": alert.preferredStyle == .actionSheet ? "actionSheet" : "alert",
            "title": alert.title ?? "",
            "message": alert.message ?? "",
            "actions": alert.actions.map { ["title": $0.title ?? "", "style": $0.style == .cancel ? "cancel" : $0.style == .destructive ? "destructive" : "default"] },
          ])
        }
        vc = presented
      }
    }
    return ["overlays": overlays]
  }
}
