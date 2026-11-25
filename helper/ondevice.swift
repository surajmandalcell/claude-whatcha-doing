// Reads {"system": "...", "text": "..."} on stdin, prints Apple's on-device model reply on stdout.
// Exits 2 with a one-line reason when the model cannot answer here.
import Foundation
import FoundationModels

struct Request: Decodable { let system: String; let text: String }

func fail(_ why: String) -> Never {
  FileHandle.standardError.write(Data((why + "\n").utf8))
  exit(2)
}

guard let req = try? JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile()) else {
  fail("bad request: want {\"system\", \"text\"} JSON on stdin")
}

switch SystemLanguageModel.default.availability {
case .available: break
case .unavailable(.appleIntelligenceNotEnabled): fail("Apple Intelligence is off")
case .unavailable(.deviceNotEligible): fail("this Mac does not support Apple Intelligence")
case .unavailable(.modelNotReady): fail("the on-device model is not ready yet")
case .unavailable(let other): fail("model unavailable: \(other)")
}

do {
  let reply = try await LanguageModelSession(instructions: req.system).respond(to: req.text)
  print(reply.content.trimmingCharacters(in: .whitespacesAndNewlines))
} catch {
  fail("model error: \(error.localizedDescription)")
}
