# 0001 Initial Architecture

## Status

Accepted

## Context

The target user has exactly two Macs and one Android phone. The product must be fast to open and support reading and simple writing to Codex sessions. A user-owned relay server is available.

## Decision

Use the user-owned relay server as a blind WebSocket relay and keep Codex access on each Mac. Android and Mac endpoints encrypt payloads end to end. The relay routes by device id and rejects routable frames whose `from` metadata does not match the socket's registered device id.

## Consequences

- The Android app does not need VPN setup or public Mac IPs.
- The relay can be operationally simple.
- The Mac agent remains the only place that can touch Codex local state.
- The protocol and pairing flow are custom and must be kept small.
