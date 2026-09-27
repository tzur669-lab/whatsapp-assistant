# Voice clips for B9 (PLAN §13, Hebrew ASR)

Drop recordings of your own voice here. **Nothing in this folder except this
file is committed** — a recording of a voice is personal data, and it stays on
this machine.

## Naming: the file name is what you said

Name each file with the exact words spoken, so the file name is the reference
transcript the recognizer is scored against:

    תזכיר לי מחר ב-8 להתקשר לאבא.ogg
    שמונה.ogg
    תקבע פגישה עם יוסי ביום שני ב-10.opus

- Any format Groq Whisper takes: `.ogg`, `.opus`, `.m4a`, `.mp3`, `.wav`,
  `.webm`, `.flac`, `.mp4`. A WhatsApp voice note saved as-is is fine.
- Up to 25 MB and 60 seconds each (§6.10 rejects longer ones anyway).
- Two recordings of the same words: add `(2)` before the extension.
- A character a file name cannot hold (`?`, `:`, `/`, `"`): leave it out.
