# Share LearnHarness from a Windows PC

The PC runs LearnHarness and saves shared progress in its existing profile. The Android app connects through your company's VPN and opens the PC's sessions. Leave LearnHarness running on the PC while you study on the phone.

Install updates for the Windows and Android packages from the [fork's GitHub Releases](https://github.com/wuyin1985/learnharness/releases).

## Configure the PC

Use the PC address and port reachable through the approved VPN. For direct HTTPS, use a PEM server certificate with that IP address or DNS name in its subject alternative names, and the matching PEM private key. Store the private key in your private Windows profile.

Create `%APPDATA%\LearnHarness\shared-learning.json` with your address and certificate paths. Relative paths are resolved from that configuration file.

```json
{
  "origin": "https://192.0.2.10:18443",
  "bindAddress": "192.0.2.10",
  "port": 18443,
  "tls": {
    "certificate": "shared-pc-tls/server.pem",
    "key": "shared-pc-tls/server-key.pem"
  }
}
```

Restart LearnHarness. Press Alt to show the menu on Windows, then choose **LearnHarness → Save Phone Connection File…**. Transfer that file to your phone. It contains the address, public certificate, and a one-time sign-in authorization that expires five minutes after export. Use the most recently exported file and export another if the PC app restarts before pairing finishes.

For a company HTTPS gateway, set `origin` to its external HTTPS origin and `port` to its local forwarding port. Leave out `bindAddress` and `tls` to bind the listener to loopback. The gateway must preserve the public Host header and stream the response. Browser clients use the gateway's certificate.

## Connect the Android app

Join the company VPN, open the session sidebar, and choose **PC connection**. Import the file to sign in automatically. Once paired, reopen the app to continue using the saved session. Export a fresh file if the previous authorization expired or was used. Existing connection files with no sign-in authorization can still use **Connect a Phone…** (Ctrl+Shift+Y) on the PC. Use **PC connection → Use this device** to return to local learning.

The app validates the PC's certificate using the imported trust material. If the PC changes address or replaces its certificate, export and import a new connection file. The shared entry supports learning sessions and their progress. Configure providers and manage local files from the PC.
