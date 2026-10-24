---
title: Platform HTTP endpoints
description: The four HTTP endpoints a platform must implement to drive Agent Bridge Service — generated from the OpenAPI contract.
---

> This page is generated from `contracts/openapi-3.1.yaml` — do not edit by hand. Run `npm run build` in `site/` to refresh.

## Endpoint index

| Method | Path | Summary |
| --- | --- | --- |
| `GET` | [`/bridge/authorize`](#op-get-bridge-authorize) | Browser authorization page |
| `POST` | [`/api/bridge/token`](#op-post-api-bridge-token) | Exchange the authorization code |
| `POST` | [`/api/bridge/device-code`](#op-post-api-bridge-device-code) | Request a device code |
| `POST` | [`/api/bridge/device-token`](#op-post-api-bridge-device-token) | Poll for the device-code result |


<a id="op-get-bridge-authorize"></a>

### GET /bridge/authorize

**Browser authorization page**

The bridge opens this URL in the system browser. Reuse the user’s existing session, then 302 back to `redirect_uri` with `code`.

**Parameters**

| Field | in | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `client_id` | query | `string` = `agent-bridge` | ✓ |  |
| `code_challenge` | query | `string` | ✓ |  |
| `code_challenge_method` | query | `string` = `S256` | ✓ |  |
| `redirect_uri` | query | `string` (uri) | ✓ |  |
| `state` | query | `string` (uuid) | ✓ |  |


**Responses**

| Status | Meaning |
| --- | --- |
| `200` |  |
| `302` |  |




<a id="op-post-api-bridge-token"></a>

### POST /api/bridge/token

**Exchange the authorization code**

The bridge calls this after receiving `code`. You MUST verify `code_verifier` against the S256 challenge: `base64url(sha256(code_verifier)) === code_challenge`.

**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | `string` | ✓ |  |
| `code_verifier` | `string` | ✓ |  |
| `redirect_uri` | `string` (uri) | ✓ |  |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**Example**

```json
{
  "code": "string",
  "code_verifier": "string",
  "redirect_uri": "string",
  "client_id": "agent-bridge"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` |  |
| `400` |  |
| `404` |  |


**Example**

```json
{
  "device_token": "string",
  "device_id": "string",
  "refresh_token": "string"
}
```




<a id="op-post-api-bridge-device-code"></a>

### POST /api/bridge/device-code

**Request a device code**

For browserless / SSH environments: hand out a short `user_code` the user confirms elsewhere.

**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**Example**

```json
{
  "client_id": "agent-bridge"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` |  |
| `404` |  |


**Example**

```json
{
  "device_code": "string",
  "user_code": "string",
  "verification_uri": "string"
}
```




<a id="op-post-api-bridge-device-token"></a>

### POST /api/bridge/device-token

**Poll for the device-code result**

Returns 4xx while the user has not confirmed (the bridge keeps polling every `interval` seconds until `expires_in`); on success returns the same shape as `/api/bridge/token`.

**Request body**


| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `device_code` | `string` | ✓ |  |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**Example**

```json
{
  "device_code": "string",
  "client_id": "agent-bridge"
}
```


**Responses**

| Status | Meaning |
| --- | --- |
| `200` |  |
| `403` |  |
| `404` |  |
| `428` |  |


**Example**

```json
{
  "device_token": "string",
  "device_id": "string",
  "refresh_token": "string"
}
```



