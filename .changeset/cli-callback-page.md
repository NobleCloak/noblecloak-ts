---
'@noblecloak/cli': patch
---

The page the browser shows after CLI sign-in is now a NobleCloak page, in light and dark, readable on a phone. It tells you to return to the terminal, where the command continues; when sign-in did not complete it says the command has stopped and to run it again, and shows the authorization server's error text (escaped). The page is one self-contained document served from 127.0.0.1 with a Content-Security-Policy that allows no script and no other origin. Exit codes and output are unchanged.
