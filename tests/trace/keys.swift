import ApplicationServices
import Foundation

let usage = "usage: keys --pid PID --fifo PATH --trace FILE"
var pid: pid_t?
var fifo = ""
var tracePath = ""
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
  switch arg {
  case "--pid": pid = args.popFirst().flatMap { pid_t($0) }
  case "--fifo": fifo = args.popFirst() ?? ""
  case "--trace": tracePath = args.popFirst() ?? ""
  default:
    FileHandle.standardError.write("\(usage)\n".data(using: .utf8)!)
    exit(2)
  }
}
guard let pid, !fifo.isEmpty, !tracePath.isEmpty else {
  FileHandle.standardError.write("\(usage)\n".data(using: .utf8)!)
  exit(2)
}
guard AXIsProcessTrusted() else {
  FileHandle.standardError.write("keys: this terminal needs Accessibility access (System Settings › Privacy & Security › Accessibility) to send keys\n".data(using: .utf8)!)
  exit(1)
}

struct Stroke {
  let code: CGKeyCode
  let flags: CGEventFlags
  let text: String?
}

let plain: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
  "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
  "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, " ": 49, "`": 50,
]
let shifted: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]
let named: [String: (CGKeyCode, CGEventFlags)] = [
  "enter": (36, []), "esc": (53, []), "tab": (48, []), "space": (49, []), "bs": (51, []),
  "up": (126, []), "down": (125, []), "left": (123, []), "right": (124, []),
  "home": (115, []), "end": (119, []), "pgup": (116, []), "pgdn": (121, []),
  "shift-up": (126, .maskShift), "shift-down": (125, .maskShift), "shift-left": (123, .maskShift),
  "shift-right": (124, .maskShift), "shift-tab": (48, .maskShift),
  "ctrl-c": (8, .maskControl), "ctrl-u": (32, .maskControl), "ctrl-v": (9, .maskControl),
  "alt-c": (8, .maskAlternate), "alt-g": (5, .maskAlternate), "alt-v": (9, .maskAlternate),
]

func strokes(_ step: String) -> [Stroke]? {
  if let (code, flags) = named[step] {
    return [Stroke(code: code, flags: flags, text: nil)]
  }
  let typed = step.hasPrefix("text:") ? String(step.dropFirst(5)) : (step.count == 1 ? step : nil)
  guard let typed else { return nil }
  return typed.map { char in
    if let code = plain[char] {
      return Stroke(code: code, flags: [], text: String(char))
    }
    if let base = shifted[char], let code = plain[base] {
      return Stroke(code: code, flags: .maskShift, text: String(char))
    }
    let lower = Character(char.lowercased())
    if char.isUppercase, let code = plain[lower] {
      return Stroke(code: code, flags: .maskShift, text: String(char))
    }
    return Stroke(code: 0, flags: [], text: String(char))
  }
}

let source = CGEventSource(stateID: .privateState)
let trace = open(tracePath, O_WRONLY | O_APPEND | O_CREAT, 0o644)
guard trace >= 0 else {
  FileHandle.standardError.write("keys: cannot write \(tracePath)\n".data(using: .utf8)!)
  exit(1)
}

func sent(_ name: String) {
  let at = Double(clock_gettime_nsec_np(CLOCK_REALTIME)) / 1e9
  let line = Array(String(format: "%.6f\t%d\tkeys\tinput.sent\t%@\n", at, getpid(), name).utf8)
  _ = line.withUnsafeBytes { write(trace, $0.baseAddress, $0.count) }
}

func post(_ stroke: Stroke) {
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: down) else { continue }
    event.flags = stroke.flags
    if let text = stroke.text {
      let units = Array(text.utf16)
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    event.postToPid(pid)
  }
}

while true {
  guard let reader = FileHandle(forReadingAtPath: fifo) else {
    FileHandle.standardError.write("keys: cannot open \(fifo)\n".data(using: .utf8)!)
    exit(1)
  }
  var pending = Data()
  while true {
    let chunk = reader.availableData
    if chunk.isEmpty { break }
    pending.append(chunk)
    while let newline = pending.firstIndex(of: 0x0a) {
      let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
      pending.removeSubrange(pending.startIndex...newline)
      if line == "quit" { exit(0) }
      if line == "warm" {
        strokes("space")?.forEach(post)
        continue
      }
      guard let list = strokes(line) else {
        FileHandle.standardError.write("keys: no key for \(line)\n".data(using: .utf8)!)
        continue
      }
      sent(line)
      for (i, stroke) in list.enumerated() {
        if i > 0 { usleep(30_000) }
        post(stroke)
      }
    }
  }
  try? reader.close()
}
