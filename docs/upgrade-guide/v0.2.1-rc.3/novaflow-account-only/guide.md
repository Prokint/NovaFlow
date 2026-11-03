---
kind: upgrade-guide
description: NovaFlow desktop model access requires account sign-in instead of manually configured API keys.
---

# NovaFlow account-only model access

English | [中文](guide.zh.md)

## Change

NovaFlow Desktop no longer enables manually configured model providers or their API-key settings page and menu entry. This affects desktop users who selected the former `NovaFlow API` provider. Model access comes from the signed-in NovaFlow account. The standalone DSH CLI is unchanged.

## Migration

1. Open the NovaFlow account page and sign in to the selected server.
2. Refresh groups and models, then select an account-authorized model in the conversation. Saved manual default selections move to an available account route or an unselected placeholder until models load.
3. Confirm that the model menu lists account models and Settings no longer offers a manual provider editor. Existing saved credentials are not used by the desktop profile; conversation records are retained.
