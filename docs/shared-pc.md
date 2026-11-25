# Share LearnHarness from a Windows PC

The PC runs LearnHarness and saves shared progress in its existing profile. The Android app connects through your company's VPN and opens the PC's sessions. Leave LearnHarness running on the PC while you study on the phone.

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

Restart LearnHarness. Use the **LearnHarness** menu to **Save Phone Connection File…** and **Connect a Phone…**. Press Alt to show the menu on Windows, or Ctrl+Shift+Y to open the sign-in code dialog directly. The connection file contains the address and public certificate. The code is separate, expires after five minutes, and can be used once.

For a company HTTPS gateway, set `origin` to its external HTTPS origin and `port` to its local forwarding port. Leave out `bindAddress` and `tls` to bind the listener to loopback. The gateway must preserve the public Host header and stream the response. Browser clients use the gateway's certificate.

## Connect the Android app

Join the company VPN, open the session sidebar, and choose **PC connection**. Import the saved connection file and enter the sign-in code from the PC. Stay on the current connection when you reopen the app. Use **PC connection → Use this device** to return to local learning.

The app validates the PC's certificate using the imported trust material. If the PC changes address or replaces its certificate, export and import a new connection file. The shared entry supports learning sessions and their progress. Configure providers and manage local files from the PC.
