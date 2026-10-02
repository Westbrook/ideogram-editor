// SOURCE-ONLY CANDIDATE: not compiled or executed. Requires macOS 15+.
// CLI: windowserver-text-session-lossless-capture CONFIG_JSON NEW_OUTPUT_DIRECTORY
// Full selected display, all windows and cursor, no audio; only the requested
// pixel ROI is retained. This is WindowServer evidence, not physical scanout or
// photons. This separate schema 4 profile preserves the full IText workload and never
// shrinks it to fit storage. Capacity is not proof that the workload ran or
// that every display refresh was captured. Missing manifest means incomplete.
// Input automation, synthetic composition, and programmatic text setters remain
// consumer labels; this collector provides no physical keyboard or OS-IME proof.

import Foundation
import CoreFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
@preconcurrency import ScreenCaptureKit
import CryptoKit
import Darwin
import zlib

private let sessionProfile = "interaction-text-106-247-60s-1"
private let storageFormat = "rfc1951-previous-roi-1"
private let codecChunkBytes = 65536
private let captureDurationMs = 75000
private let measurementDurationMs = 60000
private let referenceRefreshHz = 60
private let maximumSampleRecords = (captureDurationMs * referenceRefreshHz / 1000) * 2 + 12
// 247 existing automated dispatches have before/after ACKs; the measurement
// window has two anchors. The 64 extra records are a finite protocol margin,
// not observed actions. The consumer requires exactly 496 workload ACKs.
private let maximumClockRecords = 2 * 247 + 2 + 64
private let metadataLimit = maximumSampleRecords * 4096 + maximumClockRecords * 256
private let manifestLimit = maximumSampleRecords * 256 + 32768
private let maximumFrameBytes = 256 * 1024 * 1024
private let maximumSafeInteger = 9007199254740991
private struct CaptureFailure: Error {
    let reason: String
    init(_ reason: String) { self.reason = reason }
}
private func integer(_ value: Any?, _ minimum: Int, _ maximum: Int) throws -> Int {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
          value.doubleValue >= Double(minimum), value.doubleValue <= Double(maximum)
    else { throw CaptureFailure("invalid-config-integer") }
    return value.intValue
}
private func exactKeys(_ value: [String: Any], _ keys: [String]) throws {
    guard Set(value.keys) == Set(keys) else { throw CaptureFailure("unexpected-object-keys") }
}
private struct Configuration: Sendable {
    let displayID: UInt32
    let expectedBrowserPid: Int
    let x: Int, y: Int, width: Int, height: Int
    let capacityBytes: Int, observedAllocatedBytes: Int, reservationBytes: Int, nativeArtifactBytes: Int
    let allocationSha256: String
    var durationMs: Int { captureDurationMs }
    var maxFrames: Int { maximumSampleRecords }
    var rawFrameBytes: Int { width * height * 4 }
    var maxRawObservedBytes: Int { rawFrameBytes * maximumSampleRecords }
    var maxEncodedFrameBytes: Int { rawFrameBytes * 2 + codecChunkBytes }
    var maxBytes: Int { nativeArtifactBytes - metadataLimit - manifestLimit }
    var minimumArtifactBytes: Int { metadataLimit + manifestLimit + maxEncodedFrameBytes }
    var targetAlarmAtReservation: Bool { (observedAllocatedBytes + reservationBytes) * 10 >= capacityBytes * 8 }
    init(_ data: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let roi = object["roi"] as? [String: Any],
              let budget = object["evidenceBudget"] as? [String: Any] else { throw CaptureFailure("invalid-config") }
        try exactKeys(object, ["schemaVersion", "profile", "storageFormat", "displayID", "expectedBrowserPid", "roi", "evidenceBudget"])
        try exactKeys(roi, ["x", "y", "width", "height"])
        try exactKeys(budget, ["allocationSha256", "capacityBytes", "observedAllocatedBytes", "reservationBytes", "nativeArtifactBytes"])
        _ = try integer(object["schemaVersion"], 4, 4)
        guard object["profile"] as? String == sessionProfile,
              object["storageFormat"] as? String == storageFormat,
              let identity = budget["allocationSha256"] as? String, identity.utf8.count == 64,
              identity.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw CaptureFailure("invalid-session-profile-or-allocation-identity")
        }
        allocationSha256 = identity
        displayID = UInt32(try integer(object["displayID"], 1, Int(UInt32.max)))
        expectedBrowserPid = try integer(object["expectedBrowserPid"], 1, Int(Int32.max))
        x = try integer(roi["x"], 0, 32768)
        y = try integer(roi["y"], 0, 32768)
        width = try integer(roi["width"], 1, 32768)
        height = try integer(roi["height"], 1, 32768)
        capacityBytes = try integer(budget["capacityBytes"], 1, maximumSafeInteger)
        observedAllocatedBytes = try integer(budget["observedAllocatedBytes"], 0, maximumSafeInteger)
        reservationBytes = try integer(budget["reservationBytes"], 1, maximumSafeInteger)
        nativeArtifactBytes = try integer(budget["nativeArtifactBytes"], 1, maximumSafeInteger)
        guard width * height * 4 <= maximumFrameBytes else { throw CaptureFailure("roi-exceeds-frame-memory-bound") }
        // PERF evidence volume ceiling is reached at >=90%, not only above it.
        // The owner authenticates these facts using the existing allocation
        // source and complete sampleVolume traversal; this config is no grant
        // to enlarge an allocation or invent a replacement counter.
        guard nativeArtifactBytes >= minimumArtifactBytes, nativeArtifactBytes <= reservationBytes,
              observedAllocatedBytes + reservationBytes <= maximumSafeInteger,
              (observedAllocatedBytes + reservationBytes) * 10 < capacityBytes * 9 else {
            throw CaptureFailure("session-evidence-reservation-unavailable")
        }
    }
    var roi: [String: Int] { ["x": x, "y": y, "width": width, "height": height] }
    var evidenceBudget: [String: Any] {
        ["allocationSha256": allocationSha256, "capacityBytes": capacityBytes,
         "observedAllocatedBytes": observedAllocatedBytes, "reservationBytes": reservationBytes,
         "nativeArtifactBytes": nativeArtifactBytes]
    }
    var capacity: [String: Any] {
        ["durationMs": durationMs, "measurementDurationMs": measurementDurationMs,
         "refreshHz": referenceRefreshHz, "textActions": 106, "inputSubsteps": 247,
         "pointerSamples": 0, "dispatchClockRecords": 494, "windowAnchorClockRecords": 2,
         "maxFrames": maxFrames,
         "maxClockRecords": maximumClockRecords, "rawFrameBytes": rawFrameBytes,
         "maxRawObservedBytes": maxRawObservedBytes, "maxEncodedFrameBytes": maxEncodedFrameBytes,
         "maxEncodedPixelBytes": maxBytes,
         "metadataByteLimit": metadataLimit, "manifestByteLimit": manifestLimit,
         "minimumArtifactBytes": minimumArtifactBytes, "reservedArtifactBytes": nativeArtifactBytes]
    }
    var json: [String: Any] {
        ["schemaVersion": 4, "profile": sessionProfile, "storageFormat": storageFormat, "displayID": displayID,
         "expectedBrowserPid": expectedBrowserPid, "roi": roi, "evidenceBudget": evidenceBudget]
    }
}
private func rectJSON(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.origin.x), "y": Double(rect.origin.y),
     "width": Double(rect.width), "height": Double(rect.height)]
}
private struct WindowAdmission: Sendable {
    let ownerPID: Int
    let windowNumber: UInt32
    let bounds: CGRect
    let layer: Int
    let alpha: Double
    let roiPoints: CGRect
    let aboveVisibleWindowCount: Int
    var json: [String: Any] {
        ["ownerPID": ownerPID, "windowNumber": windowNumber, "bounds": rectJSON(bounds),
         "layer": layer, "alpha": alpha, "onScreen": true, "roiPoints": rectJSON(roiPoints),
         "aboveVisibleWindowCount": aboveVisibleWindowCount, "intersectingAboveWindowCount": 0]
    }
    func matches(_ other: WindowAdmission) -> Bool {
        ownerPID == other.ownerPID && windowNumber == other.windowNumber && bounds == other.bounds &&
        layer == other.layer && alpha == other.alpha && roiPoints == other.roiPoints
    }
}
private func windowInteger(_ value: Any?, _ minimum: Int, _ maximum: Int) throws -> Int {
    do { return try integer(value, minimum, maximum) }
    catch { throw CaptureFailure("malformed-window-numeric-metadata") }
}
private func windowAlpha(_ row: [String: Any]) throws -> Double {
    guard let number = row[kCGWindowAlpha as String] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 1 else {
        throw CaptureFailure("malformed-window-alpha")
    }
    return number.doubleValue
}
private func windowBounds(_ row: [String: Any]) throws -> CGRect {
    guard let values = row[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: values as CFDictionary),
          bounds.origin.x.isFinite, bounds.origin.y.isFinite,
          bounds.width.isFinite, bounds.height.isFinite,
          bounds.width > 0, bounds.height > 0,
          bounds.maxX.isFinite, bounds.maxY.isFinite else {
        throw CaptureFailure("malformed-window-bounds")
    }
    return bounds
}
private func inspectOwnedWindow(_ config: Configuration, width: Int, height: Int,
                                displayBounds: CGRect) throws -> WindowAdmission {
    guard displayBounds.width > 0, displayBounds.height > 0,
          let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
            as? [[String: Any]] else { throw CaptureFailure("window-admission-unavailable") }
    let scaleX = Double(width) / Double(displayBounds.width)
    let scaleY = Double(height) / Double(displayBounds.height)
    let roiPoints = CGRect(x: Double(displayBounds.minX) + Double(config.x) / scaleX,
                           y: Double(displayBounds.minY) + Double(config.y) / scaleY,
                           width: Double(config.width) / scaleX, height: Double(config.height) / scaleY)
    var matches = [(index: Int, window: WindowAdmission)]()
    for (index, row) in rows.enumerated() {
        // An undecodable owner cannot safely be excluded from the uniqueness
        // test. Never retain titles or unrelated window identifiers/geometry.
        let owner = try windowInteger(row[kCGWindowOwnerPID as String], 0, Int(Int32.max))
        guard owner == config.expectedBrowserPid else { continue }
        guard (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true else {
            throw CaptureFailure("owned-window-onscreen-state-unavailable")
        }
        let layer = try windowInteger(row[kCGWindowLayer as String], Int(Int32.min), Int(Int32.max))
        guard layer == 0 else { continue }
        let alpha = try windowAlpha(row)
        guard alpha > 0 else { continue }
        let bounds = try windowBounds(row)
        guard bounds.contains(roiPoints) else { continue }
        let number = UInt32(try windowInteger(row[kCGWindowNumber as String], 1, Int(UInt32.max)))
        matches.append((index, WindowAdmission(ownerPID: config.expectedBrowserPid, windowNumber: number,
                                              bounds: bounds, layer: layer, alpha: alpha, roiPoints: roiPoints,
                                              aboveVisibleWindowCount: 0)))
    }
    guard matches.count == 1 else { throw CaptureFailure("owned-window-containment-ambiguous-or-missing") }
    let target = matches[0]
    var aboveVisibleWindowCount = 0
    // Apple's optionOnScreenOnly contract is front-to-back ordering:
    // https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenonly
    // Use this one snapshot for target selection and all preceding windows. Do
    // not exclude desktop elements, another PID, same-PID popups, or any layer.
    for row in rows.prefix(target.index) {
        let alpha = try windowAlpha(row)
        guard alpha > 0 else { continue }
        let bounds = try windowBounds(row)
        aboveVisibleWindowCount += 1
        guard !bounds.intersects(roiPoints) else { throw CaptureFailure("roi-intersects-above-window") }
    }
    let owned = target.window
    return WindowAdmission(ownerPID: owned.ownerPID, windowNumber: owned.windowNumber,
                           bounds: owned.bounds, layer: owned.layer, alpha: owned.alpha,
                           roiPoints: roiPoints, aboveVisibleWindowCount: aboveVisibleWindowCount)
}
private func jsonData(_ object: [String: Any]) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    data.append(0x0a)
    return data
}
private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else { return }
        var offset = 0
        while offset < buffer.count {
            let count = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw CaptureFailure("write-failed") }
            offset += count
        }
    }
}
// O_NOFOLLOW at every component; directory-relative operations remain anchored
// even if a pathname is renamed. Absolute normalized paths only; no shell.
private func parentDirectory(_ path: String) throws -> (Int32, String) {
    guard path.hasPrefix("/"), path.utf8.count <= 4096,
          !path.contains("\0"), !path.hasSuffix("/") else { throw CaptureFailure("invalid-path") }
    let components = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.isEmpty,
          components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
    else { throw CaptureFailure("non-normalized-path") }
    var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard directory >= 0 else { throw CaptureFailure("root-directory-open-failed") }
    do {
        for component in components.dropLast() {
            let next = Darwin.openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw CaptureFailure("unsafe-or-missing-path-component") }
            Darwin.close(directory)
            directory = next
        }
        return (directory, components.last!)
    } catch { Darwin.close(directory); throw error }
}
private func readConfiguration(_ path: String) throws -> Configuration {
    let (parent, name) = try parentDirectory(path)
    defer { Darwin.close(parent) }
    // O_NONBLOCK prevents a FIFO/device candidate from blocking before fstat
    // rejects it. Only bounded regular files are accepted below.
    let fd = Darwin.openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw CaptureFailure("config-open-failed") }
    defer { Darwin.close(fd) }
    var info = stat()
    guard Darwin.fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_size > 0, info.st_size <= 8192 else { throw CaptureFailure("invalid-config-file") }
    var bytes = [UInt8](repeating: 0, count: 8193)
    var count = 0
    while count < bytes.count {
        let readCount = bytes.withUnsafeMutableBytes { buffer in
            Darwin.read(fd, buffer.baseAddress!.advanced(by: count), buffer.count - count)
        }
        if readCount < 0 && errno == EINTR { continue }
        guard readCount >= 0 else { throw CaptureFailure("config-read-failed") }
        if readCount == 0 { break }
        count += readCount
    }
    guard count <= 8192 else { throw CaptureFailure("config-too-large") }
    return try Configuration(Data(bytes.prefix(count)))
}

private func storagePreflight(parent: Int32, config: Configuration) throws -> [String: Any] {
    var filesystem = statfs()
    guard Darwin.fstatfs(parent, &filesystem) == 0, filesystem.f_bsize > 0 else {
        throw CaptureFailure("filesystem-capacity-unavailable")
    }
    let (available, overflow) = filesystem.f_bavail.multipliedReportingOverflow(by: UInt64(filesystem.f_bsize))
    guard !overflow, available >= UInt64(config.reservationBytes) else {
        throw CaptureFailure("filesystem-cannot-retain-session")
    }
    // This is a free-space observation, not an atomic filesystem reservation.
    // Logical file bounds exclude filesystem metadata/allocation rounding and
    // sibling evidence. The existing evidence-volume observer remains required.
    return ["availableBytesBefore": String(available), "reservedArtifactBytes": config.nativeArtifactBytes,
            "evidenceBudget": config.evidenceBudget, "targetAlarmAtReservation": config.targetAlarmAtReservation]
}
private func preflightNewOutput(_ path: String, config: Configuration) throws {
    let (parent, name) = try parentDirectory(path)
    defer { Darwin.close(parent) }
    var info = stat()
    guard Darwin.fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
        throw CaptureFailure("output-exists-or-cannot-be-inspected")
    }
    _ = try storagePreflight(parent: parent, config: config)
}

// All methods after initialization run only on the sample queue.
private final class ArtifactStore: @unchecked Sendable {
    let directory: Int32
    let storageAdmission: [String: Any]
    private let config: Configuration
    private var framesFD: Int32 = -1, pixelsFD: Int32 = -1
    private var frameHasher = SHA256(), containerHasher = SHA256()
    private(set) var metadataBytes = 0, pixelBytes = 0, encodedPixelBytes = 0, duplicateFrames = 0
    private var previousPixels: Data?
    private var previousOrdinal: Int?
    private var previousHash: String?
    private var sealed = false
    init(path: String, config: Configuration) throws {
        self.config = config
        let (parent, name) = try parentDirectory(path)
        defer { Darwin.close(parent) }
        storageAdmission = try storagePreflight(parent: parent, config: config)
        guard Darwin.mkdirat(parent, name, 0o700) == 0 else {
            throw CaptureFailure("output-exists-or-cannot-be-created")
        }
        directory = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw CaptureFailure("output-directory-open-failed") }
        var info = stat()
        guard Darwin.fstat(directory, &info) == 0, info.st_uid == geteuid(),
              (info.st_mode & 0o777) == 0o700 else {
            throw CaptureFailure("unsafe-output-directory")
        }
        framesFD = Darwin.openat(directory, "frames.ndjson", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard framesFD >= 0 else { throw CaptureFailure("frames-open-failed") }
        pixelsFD = Darwin.openat(directory, "pixels.bin", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard pixelsFD >= 0 else {
            throw CaptureFailure("pixels-open-failed")
        }
    }
    deinit {
        if framesFD >= 0 { Darwin.close(framesFD) }
        if pixelsFD >= 0 { Darwin.close(pixelsFD) }
        if directory >= 0 { Darwin.close(directory) }
    }
    // RFC1951 raw DEFLATE: negative windowBits omits the RFC1950 wrapper.
    // SDK zlib.h and https://zlib.net/manual.html document this framing.
    // Do not substitute Apple Compression output or a concatenated zlib stream.
    private func appendDeflate(_ pixels: Data) throws -> [String: Any] {
        var codec = z_stream()
        let initialized = deflateInit2_(&codec, Z_DEFAULT_COMPRESSION, Z_DEFLATED, -15, 8,
                                       Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard initialized == Z_OK else { throw CaptureFailure("deflate-initialization-failed") }
        defer { deflateEnd(&codec) }
        let bound = deflateBound(&codec, uLong(pixels.count))
        guard bound > 0, bound <= uLong(config.maxEncodedFrameBytes) else {
            throw CaptureFailure("deflate-frame-bound-unavailable")
        }
        let offset = encodedPixelBytes
        var compressedHasher = SHA256()
        var output = [UInt8](repeating: 0, count: codecChunkBytes)
        try pixels.withUnsafeBytes { input in
            guard let base = input.baseAddress?.assumingMemoryBound(to: Bytef.self) else {
                throw CaptureFailure("empty-pixel-frame")
            }
            // The input Data stays borrowed until every deflate call finishes.
            codec.next_in = UnsafeMutablePointer(mutating: base)
            codec.avail_in = uInt(input.count)
            while true {
                let beforeInput = codec.total_in, beforeOutput = codec.total_out
                let status = output.withUnsafeMutableBufferPointer { buffer -> Int32 in
                    codec.next_out = buffer.baseAddress
                    codec.avail_out = uInt(buffer.count)
                    return deflate(&codec, Z_FINISH)
                }
                guard status == Z_OK || status == Z_STREAM_END else { throw CaptureFailure("deflate-failed") }
                let count = codecChunkBytes - Int(codec.avail_out)
                guard encodedPixelBytes - offset + count <= Int(bound),
                      encodedPixelBytes - offset + count <= config.maxEncodedFrameBytes,
                      encodedPixelBytes + count <= config.maxBytes else {
                    throw CaptureFailure("encoded-pixel-byte-limit")
                }
                if count > 0 {
                    let chunk = Data(output.prefix(count))
                    // Check the reservation before every actual append. No
                    // compression ratio or future duplicate is assumed.
                    try writeAll(pixelsFD, chunk)
                    compressedHasher.update(data: chunk); containerHasher.update(data: chunk)
                    encodedPixelBytes += count
                }
                if status == Z_STREAM_END { break }
                guard codec.total_in > beforeInput || codec.total_out > beforeOutput else {
                    throw CaptureFailure("deflate-made-no-progress")
                }
            }
            guard codec.avail_in == 0, codec.total_in == uLong(pixels.count),
                  codec.total_out == uLong(encodedPixelBytes - offset) else {
                throw CaptureFailure("deflate-length-mismatch")
            }
        }
        guard encodedPixelBytes > offset, Darwin.fsync(pixelsFD) == 0 else {
            throw CaptureFailure("pixel-segment-retention-failed")
        }
        return ["kind": "deflate-raw", "offset": offset, "encodedBytes": encodedPixelBytes - offset,
                "encodedSha256": compressedHasher.finalize().map { String(format: "%02x", $0) }.joined()]
    }
    @discardableResult
    func append(_ object: [String: Any], pixels: Data? = nil, ordinal: Int? = nil) throws -> [String: Any] {
        guard !sealed else { throw CaptureFailure("artifact-sealed") }
        var record = object
        var duplicate = false
        if let pixels {
            guard let ordinal, ordinal > 0, pixels.count == config.rawFrameBytes,
                  let rawHash = object["sha256"] as? String else { throw CaptureFailure("missing-pixel-identity") }
            if let previousPixels, let previousOrdinal, pixels == previousPixels {
                guard previousOrdinal < ordinal, previousHash == rawHash else {
                    throw CaptureFailure("duplicate-pixel-identity-mismatch")
                }
                record["pixelStorage"] = ["kind": "reference", "ordinal": previousOrdinal]
                duplicate = true
            } else {
                record["pixelStorage"] = try appendDeflate(pixels)
            }
        }
        let line = try jsonData(record)
        let recordLimit = record["event"] as? String == "clock" ? 256 : 4096
        guard line.count <= recordLimit, metadataBytes + line.count <= metadataLimit else {
            throw CaptureFailure("metadata-limit")
        }
        try writeAll(framesFD, line)
        frameHasher.update(data: line); metadataBytes += line.count
        if let pixels, let ordinal {
            previousPixels = pixels; previousOrdinal = ordinal; previousHash = object["sha256"] as? String
            pixelBytes += pixels.count
            if duplicate { duplicateFrames += 1 }
        }
        return record
    }
    private func writeExclusive(_ name: String, data: Data) throws {
        guard !name.contains("/"), !name.isEmpty else { throw CaptureFailure("invalid-artifact-name") }
        let fd = Darwin.openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CaptureFailure("artifact-create-failed") }
        defer { Darwin.close(fd) }
        try writeAll(fd, data)
        guard Darwin.fsync(fd) == 0, Darwin.fchmod(fd, 0o400) == 0 else {
            throw CaptureFailure("artifact-seal-failed")
        }
    }
    func seal(_ fields: [String: Any]) throws {
        guard !sealed else { throw CaptureFailure("artifact-already-sealed") }
        guard Darwin.fsync(framesFD) == 0, Darwin.fchmod(framesFD, 0o400) == 0,
              Darwin.fsync(pixelsFD) == 0, Darwin.fchmod(pixelsFD, 0o400) == 0 else {
            throw CaptureFailure("capture-files-seal-failed")
        }
        Darwin.close(framesFD); framesFD = -1
        Darwin.close(pixelsFD); pixelsFD = -1
        previousPixels = nil
        var manifest = fields
        manifest["frames"] = ["path": "frames.ndjson", "bytes": metadataBytes,
                              "sha256": frameHasher.finalize().map { String(format: "%02x", $0) }.joined()]
        manifest["pixelContainers"] = [["path": "pixels.bin", "bytes": encodedPixelBytes,
                                       "sha256": containerHasher.finalize().map { String(format: "%02x", $0) }.joined()]]
        let data = try jsonData(manifest)
        guard data.count <= manifestLimit,
              encodedPixelBytes + metadataBytes + data.count <= config.nativeArtifactBytes else {
            throw CaptureFailure("manifest-or-reservation-limit")
        }
        try writeExclusive("manifest.pending", data: data)
        guard Darwin.linkat(directory, "manifest.pending", directory, "manifest.json", 0) == 0,
              Darwin.unlinkat(directory, "manifest.pending", 0) == 0,
              Darwin.fsync(directory) == 0, Darwin.fchmod(directory, 0o500) == 0 else {
            throw CaptureFailure("manifest-publish-failed")
        }
        sealed = true
    }
}
private final class ControlOutput: @unchecked Sendable {
    private let lock = NSLock()
    init() throws {
        let flags = Darwin.fcntl(STDOUT_FILENO, F_GETFL)
        guard flags >= 0, Darwin.fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw CaptureFailure("stdout-configuration-failed")
        }
    }
    func emit(_ object: [String: Any]) throws {
        let data = try jsonData(object)
        guard data.count <= 4096 else { throw CaptureFailure("control-output-too-large") }
        lock.lock()
        defer { lock.unlock() }
        try writeAll(STDOUT_FILENO, data)
    }
}
// The independent hard deadline does no I/O before exiting, so even a full
// stderr pipe cannot defeat bounded termination. Exit 124 means incomplete.
private final class Watchdog: @unchecked Sendable {
    private let timer: DispatchSourceTimer
    init(milliseconds: Int) {
        timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        timer.schedule(deadline: .now() + .milliseconds(milliseconds))
        timer.setEventHandler { Darwin._exit(124) }
        timer.resume()
    }
    func cancel() { timer.cancel() }
    deinit { timer.cancel() }
}

@available(macOS 15.0, *)
private final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let sampleQueue = DispatchQueue(label: "windowserver-capture.samples", qos: .userInitiated)
    private let controlQueue = DispatchQueue(label: "windowserver-capture.control", qos: .userInitiated)
    private let stateLock = NSLock()
    private let config: Configuration
    private let store: ArtifactStore
    private let output: ControlOutput
    private let width: Int, height: Int
    private let pointPixelScale: Double
    private let captureGeometry: [String: Any]
    private let outputDirectory: String
    private let displayBounds: CGRect
    private let windowAdmission: WindowAdmission
    private let timebase: mach_timebase_info_data_t
    private var stream: SCStream?
    private var stopping = false
    private var ready = false
    private var terminalReason = "unstarted"
    private var failureReason: String?
    private var streamError: [String: Any]?
    private var startedMach: UInt64 = 0
    private var completion: CheckedContinuation<Int32, Never>?
    private var durationTimer: DispatchSourceTimer?
    private var hardWatchdog: Watchdog?
    private var stdinSource: DispatchSourceRead?
    // stdinBytes/clockIDs are controlQueue-confined.
    private var stdinBytes = Data()
    private var clockIDs = Set<String>()
    // Counters and all artifact writes are sampleQueue-confined.
    private var ordinal = 0, sampleRecords = 0, completeFrames = 0, clockRecords = 0, unretainedSamples = 0
    init(config: Configuration, store: ArtifactStore, output: ControlOutput,
         width: Int, height: Int, pointPixelScale: Double, captureGeometry: [String: Any],
         outputDirectory: String, displayBounds: CGRect, windowAdmission: WindowAdmission,
         timebase: mach_timebase_info_data_t) {
        self.config = config; self.store = store; self.output = output
        self.width = width; self.height = height; self.pointPixelScale = pointPixelScale; self.timebase = timebase
        self.captureGeometry = captureGeometry; self.outputDirectory = outputDirectory
        self.displayBounds = displayBounds; self.windowAdmission = windowAdmission
        super.init()
    }
    func run(filter: SCContentFilter, setupWatchdog: Watchdog) async -> Int32 {
        let settings = SCStreamConfiguration()
        settings.width = width; settings.height = height
        settings.pixelFormat = kCVPixelFormatType_32BGRA
        settings.captureResolution = .best
        settings.scalesToFit = false
        settings.showsCursor = true
        settings.capturesAudio = false
        settings.captureMicrophone = false
        settings.queueDepth = 3
        settings.minimumFrameInterval = .zero
        // sourceRect/destinationRect unset: full display, ROI copied afterward.
        let captureStream = SCStream(filter: filter, configuration: settings, delegate: self)
        stream = captureStream
        do { try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue) }
        catch { return 1 }
        return await withCheckedContinuation { continuation in
            completion = continuation
            startedMach = mach_absolute_time()
            hardWatchdog = Watchdog(milliseconds: config.durationMs + 5000)
            setupWatchdog.cancel()
            durationTimer = DispatchSource.makeTimerSource(queue: controlQueue)
            durationTimer!.schedule(deadline: .now() + .milliseconds(config.durationMs))
            durationTimer!.setEventHandler { [weak self] in self?.stop("duration-limit") }
            do { try beginInput() }
            catch { durationTimer!.resume(); stop("stdin-setup-failed"); return }
            // Both dispatch sources are completely configured before either is
            // resumed, including for durationMs=1 or already-closed stdin.
            durationTimer!.resume()
            stdinSource!.resume()
            Task {
                do {
                    guard !isStopping() else { return }
                    try await captureStream.startCapture()
                    sampleQueue.async { [self] in
                        stateLock.lock(); let canStart = !stopping; ready = canStart; stateLock.unlock()
                        guard canStart else { return }
                        do {
                            try output.emit(["schemaVersion": 4, "event": "ready", "kind": "windowserver-text-session-capture-4",
                                             "config": config.json, "outputDirectory": outputDirectory,
                                             "capacity": config.capacity, "storageAdmission": store.storageAdmission,
                                             "display": ["id": config.displayID, "width": width, "height": height],
                                             "captureGeometry": captureGeometry,
                                             "windowAdmission": windowAdmission.json,
                                             "roi": config.roi, "timebase": ["numer": timebase.numer, "denom": timebase.denom],
                                             "startedMach": String(startedMach), "pixelByteLimit": config.maxBytes,
                                             "metadataByteLimit": metadataLimit, "manifestByteLimit": manifestLimit,
                                             "maxClockRecords": maximumClockRecords, "pointPixelScale": pointPixelScale])
                        } catch { stop("control-output-failed") }
                    }
                } catch { stop("capture-start-failed") }
            }
        }
    }
    private func isStopping() -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }; return stopping
    }
    private func beginInput() throws {
        let flags = Darwin.fcntl(STDIN_FILENO, F_GETFL)
        guard flags >= 0, Darwin.fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw CaptureFailure("stdin-configuration-failed")
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: controlQueue)
        stdinSource = source
        source.setEventHandler { [weak self] in self?.readInput() }
    }
    private func readInput() {
        guard !isStopping() else { return }
        var buffer = [UInt8](repeating: 0, count: 1024)
        // Bound each source callback so a flooding writer cannot monopolize the
        // control queue. The independent hard watchdog still bounds failure.
        for _ in 0..<8 {
            if isStopping() { return }
            let count = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
            if count < 0 { stop("stdin-read-failed"); return }
            if count == 0 { stop(stdinBytes.isEmpty ? "stdin-eof" : "malformed-control"); return }
            stdinBytes.append(contentsOf: buffer.prefix(count))
            while let newline = stdinBytes.firstIndex(of: 0x0a) {
                let line = Data(stdinBytes[..<newline]); stdinBytes.removeSubrange(...newline)
                guard line.count <= 1024 else { stop("malformed-control"); return }
                handleInput(line)
                if isStopping() { return }
            }
            guard stdinBytes.count <= 1024 else { stop("malformed-control"); return }
        }
    }
    private func handleInput(_ data: Data) {
        if data == Data("STOP".utf8) { stop("requested-stop"); return }
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let command = object["command"] as? String else { throw CaptureFailure("malformed-control") }
            if command == "stop" {
                try exactKeys(object, ["command"]); stop("requested-stop"); return
            }
            try exactKeys(object, ["command", "id"])
            guard command == "clock", let id = object["id"] as? String,
                  !id.isEmpty, id.utf8.count <= 64,
                  id.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
                  clockIDs.count < maximumClockRecords, !clockIDs.contains(id)
            else { throw CaptureFailure("malformed-control") }
            stateLock.lock()
            guard ready && !stopping else { stateLock.unlock(); throw CaptureFailure("clock-before-ready") }
            clockIDs.insert(id)
            // Enqueue under the stop fence, then sample native ticks on the same
            // queue as frame callbacks to preserve NDJSON chronological order.
            sampleQueue.async { [self] in
                do {
                    let mach = mach_absolute_time()
                    let record: [String: Any] = ["schemaVersion": 4, "event": "clock", "id": id, "mach": String(mach)]
                    try store.append(record); clockRecords += 1; try output.emit(record)
                } catch { stop("clock-retention-failed") }
            }
            stateLock.unlock()
        } catch { stop("malformed-control") }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nativeError = error as NSError
        // Framework domain/code only: never retain descriptions, userInfo, or
        // unrelated content. A malformed domain makes detail unavailable but
        // still fails the capture; it cannot turn into a successful stop.
        let domain = nativeError.domain
        stateLock.lock()
        if failureReason == nil { failureReason = "capture-stream-error" }
        if streamError == nil {
            if !domain.isEmpty, domain.utf8.count <= 256,
               domain.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) ||
                   (48...57).contains($0) || $0 == 45 || $0 == 46 || $0 == 95 }),
               nativeError.code >= -maximumSafeInteger, nativeError.code <= maximumSafeInteger {
                streamError = ["domain": domain, "code": nativeError.code]
            }
        }
        stateLock.unlock()
        stop("capture-stream-error")
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        let callbackMach = mach_absolute_time()
        guard type == .screen, !isStopping() else { return }
        guard ordinal < config.maxFrames else { stop("frame-limit"); return }
        ordinal += 1
        let windowObservationMach: UInt64
        let aboveVisibleWindowCount: Int
        do {
            // This is an adjacent current-state observation, not an atomic
            // historical window/occlusion snapshot at displayTimeMach. It can
            // detect observed drift, not every intervening move or occlusion.
            guard CGDisplayIsActive(config.displayID) != 0, CGDisplayIsAsleep(config.displayID) == 0,
                  CGDisplayBounds(config.displayID) == displayBounds,
                  let mode = CGDisplayCopyDisplayMode(config.displayID),
                  mode.pixelWidth == width, mode.pixelHeight == height else {
                throw CaptureFailure("display-geometry-drift")
            }
            let observed = try inspectOwnedWindow(config, width: width, height: height, displayBounds: displayBounds)
            guard windowAdmission.matches(observed) else { throw CaptureFailure("owned-window-geometry-drift") }
            aboveVisibleWindowCount = observed.aboveVisibleWindowCount
            windowObservationMach = mach_absolute_time()
        } catch { stop((error as? CaptureFailure)?.reason ?? "window-recheck-failed"); return }
        let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                           as? [[SCStreamFrameInfo: Any]])?.first
        let statusRaw = (attachments?[.status] as? NSNumber)?.intValue ?? -1
        let status = SCFrameStatus(rawValue: statusRaw)
        let statusName: String
        switch status {
        case .complete?: statusName = "complete"
        case .idle?: statusName = "idle"
        case .blank?: statusName = "blank"
        case .suspended?: statusName = "suspended"
        case .started?: statusName = "started"
        case .stopped?: statusName = "stopped"
        default: statusName = "unknown"
        }
        let displayMach = (attachments?[.displayTime] as? NSNumber)?.uint64Value
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let image = CMSampleBufferGetImageBuffer(sampleBuffer)
        let observedWidth = image.map(CVPixelBufferGetWidth), observedHeight = image.map(CVPixelBufferGetHeight)
        let format = image.map(CVPixelBufferGetPixelFormatType)
        var record: [String: Any] = [
            "schemaVersion": 4, "event": "sample", "ordinal": ordinal, "statusRaw": statusRaw, "status": statusName,
            "ownerPID": windowAdmission.ownerPID, "windowNumber": windowAdmission.windowNumber,
            "windowObservationMach": String(windowObservationMach),
            "aboveVisibleWindowCount": aboveVisibleWindowCount, "intersectingAboveWindowCount": 0,
            "callbackMach": String(callbackMach), "displayTimeMach": displayMach.map(String.init) as Any? ?? NSNull(),
            "pts": ["value": String(pts.value), "timescale": pts.timescale, "flags": pts.flags.rawValue, "epoch": String(pts.epoch)],
            "pixelFormat": format.map { UInt64($0) } as Any? ?? NSNull(),
            "width": observedWidth as Any? ?? NSNull(), "height": observedHeight as Any? ?? NSNull(),
            "roi": config.roi, "retained": false, "file": NSNull(), "sha256": NSNull(), "byteLength": NSNull(),
            "pixelStorage": NSNull(),
            "contentScale": (attachments?[.contentScale] as? NSNumber) as Any? ?? NSNull(),
            "scaleFactor": (attachments?[.scaleFactor] as? NSNumber) as Any? ?? NSNull()
        ]
        do {
            if status != .complete {
                record["unretainedReason"] = "non-complete-status"
                try store.append(record); sampleRecords += 1; unretainedSamples += 1
            } else {
                guard CMSampleBufferIsValid(sampleBuffer), let image, let displayMach, displayMach > 0 else {
                    throw CaptureFailure("missing-complete-frame-evidence")
                }
                guard observedWidth == width, observedHeight == height, format == kCVPixelFormatType_32BGRA,
                      CVPixelBufferGetPlaneCount(image) == 0 else { throw CaptureFailure("capture-geometry-or-format-changed") }
                guard let scale = attachments?[.contentScale] as? NSNumber, scale.doubleValue == 1 else {
                    throw CaptureFailure("scaled-capture-frame")
                }
                let bytes = try copyROI(image)
                record["retained"] = true; record["file"] = "pixels.bin"
                record["sha256"] = digest(bytes); record["byteLength"] = bytes.count
                let retainedRecord = try store.append(record, pixels: bytes, ordinal: ordinal)
                sampleRecords += 1; completeFrames += 1
                // Notify the supervisor only after this exact metadata row and
                // its pixel file are retained. Both channels use jsonData's
                // identical sorted-key NDJSON encoding. Output failure ends the
                // run unsuccessfully while preserving the retained artifacts.
                try output.emit(retainedRecord)
            }
            if ordinal >= config.maxFrames { stop("frame-limit") }
        } catch {
            // Never synthesize a display time, use another sample's bytes, or
            // resize as fallback. Failed retention makes the run unsuccessful.
            stop((error as? CaptureFailure)?.reason ?? "sample-retention-failed")
        }
    }
    private func copyROI(_ pixelBuffer: CVPixelBuffer) throws -> Data {
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else {
            throw CaptureFailure("pixel-lock-failed")
        }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard stride >= width * 4, let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw CaptureFailure("pixel-layout-invalid")
        }
        let rowBytes = config.width * 4
        var output = Data(count: rowBytes * config.height)
        output.withUnsafeMutableBytes { destination in
            for row in 0..<config.height {
                let source = base.advanced(by: (config.y + row) * stride + config.x * 4)
                destination.baseAddress!.advanced(by: row * rowBytes).copyMemory(from: source, byteCount: rowBytes)
            }
        }
        return output
    }
    private func stop(_ reason: String) {
        stateLock.lock()
        // A requested stop must not hide a later failure from an already
        // enqueued sample/clock write or framework callback. Keep the first
        // failure even when shutdown was already requested.
        if reason != "requested-stop", failureReason == nil { failureReason = reason }
        guard !stopping else { stateLock.unlock(); return }
        stopping = true; terminalReason = reason
        stateLock.unlock()
        let stopWatchdog = Watchdog(milliseconds: 5000)
        hardWatchdog?.cancel(); hardWatchdog = stopWatchdog
        durationTimer?.cancel(); stdinSource?.cancel()
        Task { [self] in
            var stopFailed = false
            if let stream {
                do { try await stream.stopCapture() } catch { stopFailed = true }
            }
            let failed = stopFailed
            sampleQueue.async { [self] in finish(stopFailed: failed) }
        }
    }
    private func finish(stopFailed: Bool) {
        stateLock.lock()
        let failure = failureReason, retainedStreamError = streamError
        stateLock.unlock()
        if stopFailed { terminalReason = "capture-stop-failed" }
        else if let failure { terminalReason = failure }
        let endedMach = mach_absolute_time()
        // Capacity/deadline/EOF are incomplete session outcomes. A successful
        // requested stop alone still does not prove the full input workload.
        let normal = ["requested-stop"]
        var exitCode: Int32 = normal.contains(terminalReason) ? 0 : 1
        do {
            try store.seal([
                "kind": "windowserver-text-session-capture-4", "schemaVersion": 4, "config": config.json,
                "capacity": config.capacity, "storageAdmission": store.storageAdmission,
                "lossObservations": ["nativeDroppedFrames": NSNull(), "completeDisplaySlotSequence": false,
                                     "streamError": retainedStreamError as Any? ?? NSNull()],
                "display": ["id": config.displayID, "width": width, "height": height],
                "captureGeometry": captureGeometry,
                "windowAdmission": windowAdmission.json,
                "timebase": ["numer": timebase.numer, "denom": timebase.denom],
                "startedMach": String(startedMach), "endedMach": String(endedMach), "terminalReason": terminalReason,
                "counts": ["sampleRecords": sampleRecords, "completeFrames": completeFrames, "clockRecords": clockRecords,
                           "unretainedSamples": unretainedSamples, "pixelBytes": store.pixelBytes,
                           "encodedPixelBytes": store.encodedPixelBytes, "duplicateFrames": store.duplicateFrames]
            ])
            try output.emit(["schemaVersion": 4, "event": "stopped", "terminalReason": terminalReason,
                             "endedMach": String(endedMach), "manifest": "manifest.json"])
        } catch { exitCode = 1 }
        hardWatchdog?.cancel()
        completion?.resume(returning: exitCode); completion = nil
    }
}

@available(macOS 15.0, *)
private func main() async -> Int32 {
    let setupWatchdog = Watchdog(milliseconds: 10000)
    defer { setupWatchdog.cancel() }
    do {
        guard CommandLine.arguments.count == 3 else { throw CaptureFailure("usage-config-and-new-output-directory") }
        let config = try readConfiguration(CommandLine.arguments[1])
        // Fail storage/path admission before any screen-capture framework use.
        try preflightNewOutput(CommandLine.arguments[2], config: config)
        // No permission-request API. Refuse before any SCK enumeration if the
        // operator has not already granted this process screen capture access.
        guard CGPreflightScreenCaptureAccess() else { throw CaptureFailure("screen-capture-not-preauthorized") }
        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = shareable.displays.first(where: { $0.displayID == config.displayID }),
              CGDisplayIsActive(config.displayID) != 0, CGDisplayIsAsleep(config.displayID) == 0 else {
            throw CaptureFailure("selected-display-unavailable")
        }
        // No window/application inclusion filters, exclusions, or desktop-
        // independent windows. The stream includes every selected-display layer.
        let filter = SCContentFilter(display: display, excludingWindows: [])
        filter.includeMenuBar = true
        let scale = Double(filter.pointPixelScale)
        // SCDisplay.width/height are points. The display mode provides backing
        // pixel dimensions; refuse disagreement rather than resampling silently.
        guard let mode = CGDisplayCopyDisplayMode(config.displayID) else {
            throw CaptureFailure("native-display-mode-unavailable")
        }
        let width = mode.pixelWidth, height = mode.pixelHeight
        let displayBounds = CGDisplayBounds(config.displayID)
        guard scale.isFinite, scale > 0, width > 0, height > 0, width <= 32768, height <= 32768,
              displayBounds.width > 0, displayBounds.height > 0,
              displayBounds == display.frame,
              Double(filter.contentRect.width) * scale == Double(width),
              Double(filter.contentRect.height) * scale == Double(height) else {
            throw CaptureFailure("native-display-geometry-unavailable")
        }
        guard width * height * 4 <= maximumFrameBytes,
              config.x + config.width <= width, config.y + config.height <= height else {
            throw CaptureFailure("display-or-roi-out-of-bounds")
        }
        let windowAdmission = try inspectOwnedWindow(config, width: width, height: height, displayBounds: displayBounds)
        var timebase = mach_timebase_info_data_t()
        guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.numer > 0, timebase.denom > 0 else {
            throw CaptureFailure("mach-timebase-unavailable")
        }
        let output = try ControlOutput(), store = try ArtifactStore(path: CommandLine.arguments[2], config: config)
        let captureGeometry: [String: Any] = [
            "displayBoundsPoints": rectJSON(displayBounds),
            "backingScale": ["x": Double(width) / Double(displayBounds.width),
                             "y": Double(height) / Double(displayBounds.height)],
            "displayPoints": ["x": display.frame.origin.x, "y": display.frame.origin.y,
                              "width": display.width, "height": display.height],
            "modePixels": ["width": width, "height": height],
            "filterPoints": ["x": filter.contentRect.origin.x, "y": filter.contentRect.origin.y,
                             "width": filter.contentRect.width, "height": filter.contentRect.height],
            "pointPixelScale": scale, "scalesToFit": false, "showsCursor": true,
            "capturesAudio": false, "queueDepth": 3, "pixelFormat": "BGRA"
        ]
        let capture = Capture(config: config, store: store, output: output, width: width, height: height,
                              pointPixelScale: scale, captureGeometry: captureGeometry,
                              outputDirectory: CommandLine.arguments[2], displayBounds: displayBounds,
                              windowAdmission: windowAdmission, timebase: timebase)
        return await capture.run(filter: filter, setupWatchdog: setupWatchdog)
    } catch {
        let reason = (error as? CaptureFailure)?.reason ?? "native-setup-failed"
        if let bytes = try? jsonData(["schemaVersion": 4, "event": "error", "reason": reason]) {
            try? writeAll(STDERR_FILENO, bytes)
        }
        return 1
    }
}

// Pipe failures are ordinary collection failures, not asynchronous termination.
signal(SIGPIPE, SIG_IGN)
let stderrFlags = Darwin.fcntl(STDERR_FILENO, F_GETFL)
if stderrFlags >= 0 { _ = Darwin.fcntl(STDERR_FILENO, F_SETFL, stderrFlags | O_NONBLOCK) }
if #available(macOS 15.0, *) {
    Task { Darwin.exit(await main()) }
    dispatchMain()
} else { Darwin.exit(1) }
