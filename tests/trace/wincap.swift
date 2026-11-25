import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

let usage = "usage: wincap (--pid PID [--newest] | --front) --out FILE [--seconds N]"
var pid: pid_t?
var front = false
var newest = false
var outPath = ""
var seconds = 600.0
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
  switch arg {
  case "--pid": pid = args.popFirst().flatMap { pid_t($0) }
  case "--front": front = true
  case "--newest": newest = true
  case "--out": outPath = args.popFirst() ?? ""
  case "--seconds": seconds = args.popFirst().flatMap { Double($0) } ?? seconds
  default:
    FileHandle.standardError.write("\(usage)\n".data(using: .utf8)!)
    exit(2)
  }
}
guard !outPath.isEmpty, pid != nil || front else {
  FileHandle.standardError.write("\(usage)\n".data(using: .utf8)!)
  exit(2)
}

_ = NSApplication.shared
FileManager.default.createFile(atPath: outPath, contents: nil)
let out = FileHandle(forWritingAtPath: outPath)!

let nsPerTick: Double = {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  return Double(info.numer) / Double(info.denom)
}()

@Sendable func wallOffset() -> Double {
  var best = Double.infinity
  var offset = 0.0
  for _ in 0..<8 {
    let a = mach_absolute_time()
    let wall = Double(clock_gettime_nsec_np(CLOCK_REALTIME))
    let b = mach_absolute_time()
    let spread = Double(b - a)
    if spread < best {
      best = spread
      offset = wall - Double(a + (b - a) / 2) * nsPerTick
    }
  }
  return offset
}

func wall(_ ticks: UInt64) -> Double {
  (Double(ticks) * nsPerTick + wallOffset()) / 1e9
}

let writer = DispatchQueue(label: "wincap.out")

func emit(_ line: String) {
  writer.sync { out.write((line + "\n").data(using: .utf8)!) }
}

let gridW = 64
let gridH = 40

final class Frames: NSObject, SCStreamOutput {
  var last: [UInt8] = []

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first,
      let raw = info[.status] as? Int,
      let status = SCFrameStatus(rawValue: raw)
    else { return }
    let at = wall((info[.displayTime] as? UInt64) ?? mach_absolute_time())
    guard status == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else {
      emit(String(format: "%.6f\t%@", at, status == .idle ? "idle" : "other"))
      return
    }

    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let w = CVPixelBufferGetWidth(pb)
    let h = CVPixelBufferGetHeight(pb)
    let row = CVPixelBufferGetBytesPerRow(pb)
    let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    var sums = [Int](repeating: 0, count: gridW * gridH)
    var counts = [Int](repeating: 0, count: gridW * gridH)
    var y = 0
    while y < h {
      let gy = y * gridH / h
      var x = 0
      while x < w {
        let p = base + y * row + x * 4
        let cell = gy * gridW + x * gridW / w
        sums[cell] += (Int(p[0]) + 2 * Int(p[1]) + Int(p[2])) / 4
        counts[cell] += 1
        x += 2
      }
      y += 2
    }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)

    var grid = [UInt8](repeating: 0, count: gridW * gridH)
    for i in 0..<grid.count where counts[i] > 0 {
      grid[i] = UInt8(sums[i] / counts[i])
    }
    var moved = 0
    if last.count == grid.count {
      for i in 0..<grid.count where grid[i] != last[i] {
        moved += 1
      }
    } else {
      moved = grid.count
    }
    if moved == 0 {
      emit(String(format: "%.6f\tsame", at))
      return
    }
    last = grid
    emit(String(format: "%.6f\tframe\t%d\t", at, moved) + grid.map { String(format: "%02x", $0) }.joined())
  }
}

func target(_ content: SCShareableContent) -> SCWindow? {
  let windows = content.windows.filter { $0.windowLayer == 0 && $0.frame.height > 50 }
  if let pid {
    let owned = windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen }
    return newest ? owned.max { $0.windowID < $1.windowID } : owned.max { $0.frame.height < $1.frame.height }
  }
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  guard let first = list.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 }),
    let number = first[kCGWindowNumber as String] as? Int
  else { return nil }
  return windows.first { Int($0.windowID) == number }
}

let frames = Frames()
var streamRef: SCStream?
let done = DispatchSemaphore(value: 0)

let signals = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { done.signal() }
  source.resume()
  return source
}

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let win = target(content) else {
      FileHandle.standardError.write("wincap: no window to capture\n".data(using: .utf8)!)
      exit(1)
    }
    let cfg = SCStreamConfiguration()
    cfg.width = Int(win.frame.width)
    cfg.height = Int(win.frame.height)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 120)
    cfg.queueDepth = 8
    cfg.showsCursor = false
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: cfg, delegate: nil)
    try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "wincap"))
    try await stream.startCapture()
    streamRef = stream
    emit(String(format: "%.6f\tstart\t%d\t%d\t%dx%d", wall(mach_absolute_time()), win.owningApplication?.processID ?? 0, win.windowID, Int(win.frame.width), Int(win.frame.height)))
    let app = win.owningApplication?.applicationName ?? "an app"
    let title = win.title.map { " (\($0))" } ?? ""
    FileHandle.standardError.write("wincap: recording \(app)'s window \(win.windowID)\(title), pid \(win.owningApplication?.processID ?? 0)\n".data(using: .utf8)!)
  } catch {
    FileHandle.standardError.write("wincap: \(error)\n".data(using: .utf8)!)
    exit(1)
  }
}

DispatchQueue.global().async {
  _ = done.wait(timeout: .now() + seconds)
  let stopped = DispatchSemaphore(value: 0)
  Task {
    try? await streamRef?.stopCapture()
    stopped.signal()
  }
  _ = stopped.wait(timeout: .now() + 2)
  emit(String(format: "%.6f\tstop", wall(mach_absolute_time())))
  try? out.synchronize()
  exit(0)
}

dispatchMain()
