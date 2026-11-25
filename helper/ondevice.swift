// Reads {"system": "...", "text": "..."} on stdin, prints Apple's on-device model reply on stdout.
// Exits 2 with a one-line reason when the model can never answer on this Mac (the caller stops asking),
// 1 when only this request failed (a guardrail, a too-long input, a model still loading).
import Foundation
import FoundationModels

struct Request: Decodable { let system: String; let text: String }

func fail(_ why: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((why + "\n").utf8))
  exit(code)
}

guard let req = try? JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile()) else {
  fail("bad request: want {\"system\", \"text\"} JSON on stdin")
}

switch SystemLanguageModel.default.availability {
case .available: break
case .unavailable(.appleIntelligenceNotEnabled): fail("Apple Intelligence is off", 2)
case .unavailable(.deviceNotEligible): fail("this Mac does not support Apple Intelligence", 2)
case .unavailable(.modelNotReady): fail("the on-device model is not ready yet")
case .unavailable(let other): fail("model unavailable: \(other)", 2)
}

do {
  let reply = try await LanguageModelSession(instructions: req.system).respond(to: req.text)
  print(reply.content.trimmingCharacters(in: .whitespacesAndNewlines))
} catch {
  fail("model error: \(error.localizedDescription)")
}
