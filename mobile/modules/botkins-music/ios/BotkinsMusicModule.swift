// Apple Music as a phone capability: catalog/library lookup, SystemMusicPlayer playback, and
// playlist/library changes. No MusicKit object or private token leaves this native boundary.
import ExpoModulesCore
import Foundation
import MusicKit

private enum MusicItemKind: String {
  case song, album, playlist, artist

  static func parse(_ value: String) -> MusicItemKind? {
    MusicItemKind(rawValue: value)
  }
}

private enum MusicItemSource: String {
  case catalog, library
}

private enum MusicLibraryKind: String {
  case playlists, recent
}

private enum MusicControl: String {
  case pause, resume, next, previous, stop
}

private enum MusicFailure: Error {
  case unavailable
  case denied
  case subscriptionRequired
  case serviceUnavailable
  case notFound
  case failed
}

public final class BotkinsMusicModule: Module {
  private let lock = NSLock()
  private var grantRevision = 0
  private var grantLevel = "off"

  public func definition() -> ModuleDefinition {
    Name("BotkinsMusic")
    Events("changed")

    Function("setGrant") { (revision: Int, level: String) in
      self.lock.lock()
      self.grantRevision = revision
      self.grantLevel = level
      self.lock.unlock()
    }

    AsyncFunction("authorization") { self.authorizationText() }
    AsyncFunction("requestAuthorization") { () async -> String in
      await self.requestAuthorization()
    }
    AsyncFunction("canPlayCatalog") { (grant: Int) async throws -> Bool in
      try await self.canPlayCatalog(grant)
    }
    AsyncFunction("search") { (query: String, kinds: [String], source: String, limit: Int, grant: Int) async throws -> [[String: Any]] in
      try await self.search(query, kinds, source, limit, grant)
    }
    AsyncFunction("library") { (kind: String, limit: Int, grant: Int) async throws -> [[String: Any]] in
      try await self.library(kind, limit, grant)
    }
    AsyncFunction("nowPlaying") { (grant: Int) async throws -> [String: Any] in
      try await self.nowPlaying(grant)
    }
    AsyncFunction("play") { (id: String, kind: String, source: String, shuffle: Bool?, grant: Int) async throws -> [String: Any] in
      try await self.play(id, kind, source, shuffle, grant)
    }
    AsyncFunction("control") { (action: String, grant: Int) async throws -> [String: Any] in
      try await self.control(action, grant)
    }
    AsyncFunction("createPlaylist") { (name: String, description: String?, songIds: [String], grant: Int) async throws -> [String: Any] in
      try await self.createPlaylist(name, description, songIds, grant)
    }
    AsyncFunction("addToPlaylist") { (playlistId: String, songIds: [String], grant: Int) async throws -> [String: Any] in
      try await self.addToPlaylist(playlistId, songIds, grant)
    }
    AsyncFunction("addToLibrary") { (id: String, kind: String, grant: Int) async throws -> [String: Any] in
      try await self.addToLibrary(id, kind, grant)
    }
  }

  @MainActor
  private func requestAuthorization() async -> String {
    if MusicAuthorization.currentStatus == .notDetermined {
      _ = await MusicAuthorization.request()
    }
    return self.authorizationText()
  }

  @MainActor
  private func canPlayCatalog(_ grant: Int) async throws -> Bool {
    try self.requireGrant(grant, interact: false)
    return (try? await MusicSubscription.current.canPlayCatalogContent) ?? false
  }

  @MainActor
  private func search(_ query: String, _ kinds: [String], _ source: String, _ limit: Int, _ grant: Int) async throws -> [[String: Any]] {
    try self.requireGrant(grant, interact: false)
    guard let source = MusicItemSource(rawValue: source), (1...25).contains(limit) else {
      throw MusicFailure.failed
    }
    let parsed = try kinds.map {
      guard let kind = MusicItemKind.parse($0) else { throw MusicFailure.failed }
      return kind
    }
    do {
      let items: [FoundItem]
      switch source {
      case .catalog:
        let types: [any MusicCatalogSearchable.Type] = parsed.map { $0.catalogType }
        var request = MusicCatalogSearchRequest(term: query, types: types)
        request.limit = limit
        let response = try await request.response()
        items = Self.found(songs: response.songs, albums: response.albums, playlists: response.playlists, artists: response.artists, source: .catalog)
      case .library:
        let types: [any MusicLibrarySearchable.Type] = parsed.map { $0.libraryType }
        var request = MusicLibrarySearchRequest(term: query, types: types)
        request.limit = limit
        let response = try await request.response()
        items = Self.found(songs: response.songs, albums: response.albums, playlists: response.playlists, artists: response.artists, source: .library)
      }
      try self.requireGrant(grant, interact: false)
      return items.map(\.dictionary)
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func library(_ kind: String, _ limit: Int, _ grant: Int) async throws -> [[String: Any]] {
    try self.requireGrant(grant, interact: false)
    guard let kind = MusicLibraryKind(rawValue: kind), (1...50).contains(limit) else {
      throw MusicFailure.failed
    }
    do {
      let items: [FoundItem]
      switch kind {
      case .playlists:
        var request = MusicLibraryRequest<Playlist>()
        request.limit = limit
        request.sort(by: \.name, ascending: true)
        items = Self.found(songs: [], albums: [], playlists: try await request.response().items, artists: [], source: .library)
      case .recent:
        var request = MusicLibraryRequest<Song>()
        request.limit = min(limit * 4, 200)
        request.sort(by: \.lastPlayedDate, ascending: false)
        let played = try await request.response().items.filter { $0.lastPlayedDate != nil }
        items = Self.found(songs: played.prefix(limit), albums: [], playlists: [], artists: [], source: .library)
      }
      try self.requireGrant(grant, interact: false)
      return items.map(\.dictionary)
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func nowPlaying(_ grant: Int) throws -> [String: Any] {
    try self.requireGrant(grant, interact: false)
    return self.playing()
  }

  @MainActor
  private func play(_ id: String, _ kind: String, _ source: String, _ shuffle: Bool?, _ grant: Int) async throws -> [String: Any] {
    try self.requireGrant(grant, interact: true)
    guard let kind = MusicItemKind.parse(kind), let source = MusicItemSource(rawValue: source) else {
      throw MusicFailure.failed
    }
    do {
      let player = SystemMusicPlayer.shared
      let itemID = MusicItemID(id)
      let queue: MusicKit.MusicPlayer.Queue
      switch kind {
      case .song:
        queue = SystemMusicPlayer.Queue(for: [try await self.song(itemID, source: source)])
      case .album:
        queue = SystemMusicPlayer.Queue(for: [try await self.album(itemID, source: source)])
      case .playlist:
        queue = SystemMusicPlayer.Queue(for: [try await self.playlist(itemID, source: source)])
      case .artist:
        let songs = try await self.songs(by: itemID, source: source)
        guard !songs.isEmpty else { throw MusicFailure.notFound }
        queue = SystemMusicPlayer.Queue(for: songs)
      }
      try self.requireGrant(grant, interact: true)
      if source == .catalog {
        guard (try? await MusicSubscription.current.canPlayCatalogContent) == true else {
          throw MusicFailure.subscriptionRequired
        }
        try self.requireGrant(grant, interact: true)
      }
      player.queue = queue
      if let shuffle {
        player.state.shuffleMode = shuffle ? .songs : .off
      }
      try await player.play()
      self.sendEvent("changed", ["state": self.playing()["state"] ?? "playing"])
      return self.playing()
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func control(_ action: String, _ grant: Int) async throws -> [String: Any] {
    try self.requireGrant(grant, interact: true)
    guard let action = MusicControl(rawValue: action) else { throw MusicFailure.failed }
    let player = SystemMusicPlayer.shared
    do {
      switch action {
      case .pause:
        player.pause()
        await self.settle(player, states: [.paused, .stopped])
      case .resume:
        guard player.queue.currentEntry != nil else { throw MusicFailure.notFound }
        try await player.play()
        await self.settle(player, states: [.playing])
      case .next:
        guard player.queue.currentEntry != nil else { throw MusicFailure.notFound }
        try await player.skipToNextEntry()
      case .previous:
        guard player.queue.currentEntry != nil else { throw MusicFailure.notFound }
        try await player.skipToPreviousEntry()
      case .stop:
        player.stop()
        await self.settle(player, states: [.stopped])
      }
      try self.requireGrant(grant, interact: true)
      let state = self.playing()
      self.sendEvent("changed", ["state": state["state"] ?? "stopped"])
      return state
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func createPlaylist(_ name: String, _ description: String?, _ songIds: [String], _ grant: Int) async throws -> [String: Any] {
    try self.requireGrant(grant, interact: true)
    do {
      let songs = try await self.resolveSongs(songIds, grant: grant)
      try self.requireGrant(grant, interact: true)
      let playlist = try await MusicLibrary.shared.createPlaylist(name: name, description: description, items: songs)
      return ["id": playlist.id.rawValue]
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func addToPlaylist(_ playlistId: String, _ songIds: [String], _ grant: Int) async throws -> [String: Any] {
    try self.requireGrant(grant, interact: true)
    do {
      var request = MusicLibraryRequest<Playlist>()
      request.filter(matching: \.id, equalTo: MusicItemID(playlistId))
      request.limit = 1
      guard var playlist = try await request.response().items.first else {
        throw MusicFailure.notFound
      }
      let songs = try await self.resolveSongs(songIds, grant: grant)
      for song in songs {
        try self.requireGrant(grant, interact: true)
        playlist = try await MusicLibrary.shared.add(song, to: playlist)
      }
      return ["id": playlist.id.rawValue]
    } catch {
      throw Self.map(error)
    }
  }

  @MainActor
  private func addToLibrary(_ id: String, _ kind: String, _ grant: Int) async throws -> [String: Any] {
    try self.requireGrant(grant, interact: true)
    guard let kind = MusicItemKind.parse(kind), kind != .artist else { throw MusicFailure.failed }
    do {
      let itemID = MusicItemID(id)
      if try await self.libraryHas(itemID, kind: kind) {
        return ["id": id]
      }
      guard (try? await MusicSubscription.current.canPlayCatalogContent) == true else {
        throw MusicFailure.subscriptionRequired
      }
      try self.requireGrant(grant, interact: true)
      switch kind {
      case .song:
        let item = try await self.catalogSong(itemID)
        try self.requireGrant(grant, interact: true)
        try await MusicLibrary.shared.add(item)
      case .album:
        let item = try await self.catalogAlbum(itemID)
        try self.requireGrant(grant, interact: true)
        try await MusicLibrary.shared.add(item)
      case .playlist:
        let item = try await self.catalogPlaylist(itemID)
        try self.requireGrant(grant, interact: true)
        try await MusicLibrary.shared.add(item)
      case .artist:
        throw MusicFailure.failed
      }
      return ["id": id]
    } catch MusicLibrary.Error.itemAlreadyAdded {
      return ["id": id]
    } catch {
      throw Self.map(error)
    }
  }

  private func authorizationText() -> String {
    switch MusicAuthorization.currentStatus {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .authorized: return "authorized"
    @unknown default: return "denied"
    }
  }

  private func requireGrant(_ revision: Int, interact: Bool) throws {
    lock.lock()
    let matches = grantRevision == revision
    let allowed = grantLevel == "interact" || (!interact && grantLevel == "read")
    lock.unlock()
    guard matches && allowed else { throw MusicFailure.denied }
    guard MusicAuthorization.currentStatus == .authorized else { throw MusicFailure.denied }
  }

  private func playing() -> [String: Any] {
    let player = SystemMusicPlayer.shared
    let state: String
    switch player.state.playbackStatus {
    case .playing, .seekingForward, .seekingBackward: state = "playing"
    case .paused, .interrupted: state = "paused"
    case .stopped: state = "stopped"
    @unknown default: state = "stopped"
    }
    var result: [String: Any] = [
      "state": state,
      "positionSeconds": max(0, min(player.playbackTime, 1_000_000)),
    ]
    guard let entry = player.queue.currentEntry else { return result }
    var item: [String: Any] = ["id": entry.id, "title": entry.title]
    if let subtitle = entry.subtitle, !subtitle.isEmpty { item["artist"] = subtitle }
    switch entry.item {
    case .song(let song)?:
      item = ["id": song.id.rawValue, "title": song.title]
      if !song.artistName.isEmpty { item["artist"] = song.artistName }
      if let album = song.albumTitle { item["album"] = album }
      if let duration = song.duration { item["durationSeconds"] = Int(duration.rounded()) }
    case .musicVideo(let video)?:
      item = ["id": video.id.rawValue, "title": video.title]
      if !video.artistName.isEmpty { item["artist"] = video.artistName }
      if let album = video.albumTitle { item["album"] = album }
      if let duration = video.duration { item["durationSeconds"] = Int(duration.rounded()) }
    default:
      break
    }
    result["item"] = item
    return result
  }

  private func settle(_ player: SystemMusicPlayer, states: Set<MusicKit.MusicPlayer.PlaybackStatus>) async {
    for _ in 0..<10 {
      if states.contains(player.state.playbackStatus) { return }
      try? await Task.sleep(for: .milliseconds(80))
    }
  }

  private func resolveSongs(_ identifiers: [String], grant: Int) async throws -> [Song] {
    guard !identifiers.isEmpty else { return [] }
    let unique = identifiers.reduce(into: [String]()) { all, id in
      if !all.contains(id) { all.append(id) }
    }
    var found: [String: Song] = [:]
    var library = MusicLibraryRequest<Song>()
    library.filter(matching: \.id, memberOf: unique.map { MusicItemID($0) })
    library.limit = unique.count
    for song in try await library.response().items {
      found[song.id.rawValue] = song
    }
    let missing = unique.filter { found[$0] == nil }
    if !missing.isEmpty {
      guard (try? await MusicSubscription.current.canPlayCatalogContent) == true else {
        throw MusicFailure.subscriptionRequired
      }
      var catalog = MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: missing.map { MusicItemID($0) })
      catalog.limit = missing.count
      for song in try await catalog.response().items {
        found[song.id.rawValue] = song
      }
    }
    try requireGrant(grant, interact: true)
    let songs = identifiers.compactMap { found[$0] }
    guard songs.count == identifiers.count else { throw MusicFailure.notFound }
    return songs
  }

  private func libraryHas(_ id: MusicItemID, kind: MusicItemKind) async throws -> Bool {
    switch kind {
    case .song:
      var request = MusicLibraryRequest<Song>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      return !(try await request.response().items.isEmpty)
    case .album:
      var request = MusicLibraryRequest<Album>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      return !(try await request.response().items.isEmpty)
    case .playlist:
      var request = MusicLibraryRequest<Playlist>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      return !(try await request.response().items.isEmpty)
    case .artist:
      return false
    }
  }

  private func song(_ id: MusicItemID, source: MusicItemSource) async throws -> Song {
    switch source {
    case .catalog:
      return try await catalogSong(id)
    case .library:
      var request = MusicLibraryRequest<Song>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
      return item
    }
  }

  private func album(_ id: MusicItemID, source: MusicItemSource) async throws -> Album {
    switch source {
    case .catalog:
      return try await catalogAlbum(id)
    case .library:
      var request = MusicLibraryRequest<Album>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
      return item
    }
  }

  private func playlist(_ id: MusicItemID, source: MusicItemSource) async throws -> Playlist {
    switch source {
    case .catalog:
      return try await catalogPlaylist(id)
    case .library:
      var request = MusicLibraryRequest<Playlist>()
      request.filter(matching: \.id, equalTo: id)
      request.limit = 1
      guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
      return item
    }
  }

  private func songs(by id: MusicItemID, source: MusicItemSource) async throws -> [Song] {
    switch source {
    case .catalog:
      var request = MusicCatalogResourceRequest<Artist>(matching: \.id, equalTo: id)
      request.limit = 1
      guard let artist = try await request.response().items.first else { throw MusicFailure.notFound }
      return Array((try await artist.with([.topSongs])).topSongs ?? [])
    case .library:
      var artists = MusicLibraryRequest<Artist>()
      artists.filter(matching: \.id, equalTo: id)
      artists.limit = 1
      guard let artist = try await artists.response().items.first else { throw MusicFailure.notFound }
      var request = MusicLibraryRequest<Song>()
      request.filter(matching: \.artists, contains: artist)
      request.limit = 100
      return Array(try await request.response().items)
    }
  }

  private func catalogSong(_ id: MusicItemID) async throws -> Song {
    var request = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: id)
    request.limit = 1
    guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
    return item
  }

  private func catalogAlbum(_ id: MusicItemID) async throws -> Album {
    var request = MusicCatalogResourceRequest<Album>(matching: \.id, equalTo: id)
    request.limit = 1
    guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
    return item
  }

  private func catalogPlaylist(_ id: MusicItemID) async throws -> Playlist {
    var request = MusicCatalogResourceRequest<Playlist>(matching: \.id, equalTo: id)
    request.limit = 1
    guard let item = try await request.response().items.first else { throw MusicFailure.notFound }
    return item
  }

  nonisolated private static func map(_ error: any Error) -> any Error {
    if error is CancellationError || error is Exception { return error }
    if let failure = error as? MusicFailure {
      switch failure {
      case .unavailable: return Exception(name: "E_MUSIC_UNAVAILABLE", description: "Apple Music is unavailable.")
      case .denied: return Exception(name: "E_MUSIC_PERMISSION", description: "Apple Music permission is off or changed.")
      case .subscriptionRequired: return Exception(name: "E_MUSIC_SUBSCRIPTION", description: "An Apple Music subscription is required.")
      case .serviceUnavailable: return Exception(name: "E_MUSIC_SERVICE", description: "Apple Music is unavailable just now.")
      case .notFound: return Exception(name: "E_MUSIC_NOT_FOUND", description: "That Apple Music item was not found.")
      case .failed: return Exception(name: "E_MUSIC_FAILED", description: "Apple Music could not do that.")
      }
    }
    if error is URLError { return Exception(name: "E_MUSIC_SERVICE", description: "Apple Music is unavailable just now.") }
    return Exception(name: "E_MUSIC_FAILED", description: "Apple Music could not do that.")
  }

  private struct FoundItem {
    let id: String
    let kind: MusicItemKind
    let title: String
    let artist: String?
    let album: String?
    let source: MusicItemSource

    var dictionary: [String: Any] {
      var result: [String: Any] = ["id": id, "type": kind.rawValue, "title": title, "source": source.rawValue]
      if let artist, !artist.isEmpty { result["artist"] = artist }
      if let album, !album.isEmpty { result["album"] = album }
      return result
    }
  }

  nonisolated private static func found(
    songs: some Collection<Song>,
    albums: some Collection<Album>,
    playlists: some Collection<Playlist>,
    artists: some Collection<Artist>,
    source: MusicItemSource
  ) -> [FoundItem] {
    songs.map { FoundItem(id: $0.id.rawValue, kind: .song, title: $0.title, artist: $0.artistName, album: $0.albumTitle, source: source) }
      + albums.map { FoundItem(id: $0.id.rawValue, kind: .album, title: $0.title, artist: $0.artistName, album: nil, source: source) }
      + playlists.map { FoundItem(id: $0.id.rawValue, kind: .playlist, title: $0.name, artist: $0.curatorName, album: nil, source: source) }
      + artists.map { FoundItem(id: $0.id.rawValue, kind: .artist, title: $0.name, artist: nil, album: nil, source: source) }
  }
}

private extension MusicItemKind {
  var catalogType: any MusicCatalogSearchable.Type {
    switch self {
    case .song: return Song.self
    case .album: return Album.self
    case .playlist: return Playlist.self
    case .artist: return Artist.self
    }
  }

  var libraryType: any MusicLibrarySearchable.Type {
    switch self {
    case .song: return Song.self
    case .album: return Album.self
    case .playlist: return Playlist.self
    case .artist: return Artist.self
    }
  }
}
