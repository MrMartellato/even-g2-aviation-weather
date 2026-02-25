<div align="center">
  <img src="qr-code.png" alt="QR Code" width="200"/>
</div>

# Even Realities G2 Aviation Weather

A web application designed for the Even Realities G2 smart glasses that fetches and displays real-time aviation weather data (METARs and TAFs).

## Features

- **Nearby Stations**: Uses geolocation to automatically find and display weather for METAR stations within a 75 NM radius, sorted by distance.
- **Custom Station Lists**: Configure up to two separate lists of specific ICAO station codes to monitor.
- **TAF Support**: Optionally include Terminal Aerodrome Forecasts alongside METAR data.
- **Smart Glasses Integration**: Designed specifically to interface with the Even Realities G2 glasses via the Even Hub SDK, providing a seamless head-up display of weather information.

## Getting Started

1.  Connect your Even Realities G2 glasses using the Even Hub simulator or actual hardware.
2.  Open the web interface.
3.  Configure your desired stations or use the "Nearby" feature.
4.  View the weather data directly on your glasses!

## Development

This project is built using:
- TypeScript
- Vite
- Vanilla CSS
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)

---
*Built with Antigravity - Powered by Gemini 3.1 Pro and Sonnet 4.6*
