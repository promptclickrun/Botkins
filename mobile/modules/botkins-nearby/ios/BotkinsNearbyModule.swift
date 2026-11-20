// Finds Botkins computers on the local network.
//
// The desktop app announces itself over Bonjour while phone access is on:
//   service type  _botkins._tcp   (domain local.)
//   instance name the computer's name
//   TXT           v=<link protocol>  id=<the computer's id, the same one its hello returns>
//   SRV           the link's port
// This module browses for that type and, for each computer found, learns an address and port by
// opening (and at once closing) a connection to the announced service. JavaScript gets the whole
// list each time it changes: [{ name, id, version, host }], where host is "address:port" once known.
import ExpoModulesCore
import Network

private let serviceType = "_botkins._tcp"
private let onChange = "onChange"

public final class BotkinsNearbyModule: Module {
  private let queue = DispatchQueue(label: "app.botkins.nearby")
  private var browser: NWBrowser?
  /// What the browser reports now, by instance name.
  private var found: [String: [String: String]] = [:]
  /// Addresses learned so far, by instance name.
  private var hosts: [String: String] = [:]
  private var resolving: [String: NWConnection] = [:]
  private var problem: String?

  public func definition() -> ModuleDefinition {
    Name("BotkinsNearby")

    Events(onChange)

    // Browsing runs only while JavaScript is listening.
    OnStartObserving(onChange) {
      self.queue.async { self.start() }
    }
    OnStopObserving(onChange) {
      self.queue.async { self.stop() }
    }
    OnDestroy {
      self.queue.async { self.stop() }
    }
  }

  private func start() {
    stop()
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: serviceType, domain: "local."), using: parameters)
    browser.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .failed(let error):
        self.problem = "\(error)"
        self.emit()
      case .waiting(let error):
        // The person has not allowed the local network (or it is off).
        self.problem = "\(error)"
        self.emit()
      case .ready:
        self.problem = nil
        self.emit()
      default:
        break
      }
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      self?.update(results)
    }
    browser.start(queue: queue)
    self.browser = browser
  }

  private func stop() {
    browser?.cancel()
    browser = nil
    for connection in resolving.values { connection.cancel() }
    resolving = [:]
    found = [:]
    hosts = [:]
    problem = nil
  }

  private func update(_ results: Set<NWBrowser.Result>) {
    var next: [String: [String: String]] = [:]
    for result in results {
      guard case let .service(name, _, _, _) = result.endpoint else { continue }
      var entry = ["name": name]
      if case let .bonjour(record) = result.metadata {
        if let id = record["id"] { entry["id"] = id }
        if let version = record["v"] { entry["version"] = version }
      }
      next[name] = entry
      if hosts[name] == nil && resolving[name] == nil { resolve(name, result.endpoint) }
    }
    for name in found.keys where next[name] == nil {
      hosts[name] = nil
      resolving[name]?.cancel()
      resolving[name] = nil
    }
    found = next
    emit()
  }

  /// Learns where a service lives: connects to it, reads the far end's address and port, and lets go.
  private func resolve(_ name: String, _ endpoint: NWEndpoint) {
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = false
    // The link takes IPv4 addresses and names, and the desktop app announces IPv4 only.
    if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let connection = NWConnection(to: endpoint, using: parameters)
    resolving[name] = connection
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint {
          var address = "\(host)"
          // "192.168.1.20%en0": the interface is not part of the address.
          if let cut = address.firstIndex(of: "%") { address = String(address[..<cut]) }
          if !address.contains(":") {
            self.hosts[name] = "\(address):\(port.rawValue)"
          }
        }
        self.finish(name, connection)
      case .failed, .cancelled:
        self.finish(name, connection)
      default:
        break
      }
    }
    connection.start(queue: queue)
    // A computer that doesn't answer is given up on; the browser reports it again if it changes.
    queue.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, self.resolving[name] === connection else { return }
      self.finish(name, connection)
    }
  }

  private func finish(_ name: String, _ connection: NWConnection) {
    guard resolving[name] === connection else { return }
    resolving[name] = nil
    connection.stateUpdateHandler = nil
    connection.cancel()
    emit()
  }

  private func emit() {
    let computers: [[String: String]] = found.values
      .map { entry in
        var out = entry
        if let name = entry["name"], let host = hosts[name] { out["host"] = host }
        return out
      }
      .sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
    var body: [String: Any] = ["computers": computers, "looking": browser != nil]
    if let problem { body["problem"] = problem }
    sendEvent(onChange, body)
  }
}
