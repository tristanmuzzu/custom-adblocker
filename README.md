# Custom Adblocker

A Manifest V3 extension for Chrome, Edge, Brave and other Chromium browsers.
Blocks ads, popups and popunder tabs by behaviour, not just by domain list,
and handles YouTube ads. One-click on/off and per-site pause.

## Install on Windows

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/tristanmuzzu/custom-adblocker/main/install.ps1 | iex
```

This puts the extension in `%LOCALAPPDATA%\CustomAdblocker` and opens the
extensions page. Then, once:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick `%LOCALAPPDATA%\CustomAdblocker`
   (the script copied the full path to the clipboard).
3. Pin **Custom Adblocker** from the puzzle-piece menu.

Leave that folder in place; the browser loads the extension from it.
Browsers block automatic loading of unpacked extensions, so those clicks
can't be scripted.

**Update:** run the same command again, click the reload arrow on the
Custom Adblocker card, and refresh open tabs.

## Install on macOS or Linux

Download this repository (Code → Download ZIP), unzip it somewhere permanent,
then do steps 1–3 above with that folder.

## Using it

- **Toolbar icon:** master switch, block counter, per-site controls.
- **Alt+Shift+A:** turn it on or off.
- **Pause on this site:** leaves one site alone.
- **Strict:** closes any tab a site opens toward a different site.

Not for Firefox.

## For Claude Code

If someone asks you to install this: run the PowerShell command above (on
Windows), then walk them through steps 1–3, telling them the exact folder
path the script printed. Check with them that the Custom Adblocker card
appears with no errors and that the icon shows in the toolbar.
