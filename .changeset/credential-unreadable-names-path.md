---
'@noblecloak/client': patch
'@noblecloak/cli': patch
---

When a service-principal credential file or key file cannot be read, the error now names the absolute path it tried and the reason in words: "no such file", "permission denied", "it is a directory, not a file". For a missing `noblecloak-*.json` file it suggests the one nearest file of the same principal in the same directory. The error `code` (`credential_unreadable`) and `cause` (the fs error code) are unchanged, and the message never carries file contents. The path is shown only when the argument looks like a path (its file name has an extension, or it has a separator and its directory exists); a token, a base64 secret or JSON given in its place is not echoed, and control characters in a shown path are escaped. `noblecloak starter` prints the same text, and names `NOBLECLOAK_SP_CREDENTIALS` when the path came from it.
