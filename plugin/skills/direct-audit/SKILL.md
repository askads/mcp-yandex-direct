---
name: direct-audit
description: Audit a Yandex Direct account: list campaigns of every type, pull report statistics in one wide request, and respect the daily Units quota and the Reports service limits.
---

# Yandex Direct MCP

## What this server covers

Yandex Direct is one advertiser's ad account: search and networks. It is not Yandex
Metrica — there is no web analytics here. New campaigns and ads can only be created as
text ones, but objects of any type can be listed, renamed, re-budgeted, paused, archived
and deleted by id.

## Check whose account you are in

An agency token operates on the agency's own account until a client login is set. Check
that before trusting an empty campaign list — an empty result usually means the wrong
account, not an empty account.

## Filtering campaigns

A type filter that omits `UNIFIED_CAMPAIGN` hides current performance campaigns. When
listing campaigns to answer "what is running", do not filter by type at all.

## Quota and statistics

Every call spends the daily Units quota; `get_quota` shows what is left. Statistics run as
an asynchronous task in the Reports service, which has its own daily limits. Request
**one wide period** rather than looping over days or campaigns.

## Writes spend real money

Unless sandbox mode is on, writes spend real money and deletion is irreversible. A
partially failed batch still returns HTTP 200 — read the per-object errors and retry only
the objects that failed, never the whole batch.

