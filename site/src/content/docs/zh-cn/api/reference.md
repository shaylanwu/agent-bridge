---
title: 平台 HTTP 端点
description: 平台要驱动 Agent Bridge Service 必须实现的四个 HTTP 端点 —— 由 OpenAPI 契约生成。
---

> 本页由 `contracts/openapi-3.1.yaml` 生成 —— 请勿手工编辑。在 `site/` 下执行 `npm run build` 会自动刷新。

## 端点索引

| 方法 | 路径 | 摘要 |
| --- | --- | --- |
| `GET` | [`/bridge/authorize`](#op-get-bridge-authorize) | 浏览器授权页 |
| `POST` | [`/api/bridge/token`](#op-post-api-bridge-token) | 用授权码换取 device_token |
| `POST` | [`/api/bridge/device-code`](#op-post-api-bridge-device-code) | 申请设备码 |
| `POST` | [`/api/bridge/device-token`](#op-post-api-bridge-device-token) | 轮询设备码结果 |


<a id="op-get-bridge-authorize"></a>

### GET /bridge/authorize

**浏览器授权页**

bridge 会用系统默认浏览器打开该 URL。复用用户已有登录态，确认后带 `code` 302 回 `redirect_uri`。

**参数**

| 字段 | in | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `client_id` | query | `string` = `agent-bridge` | ✓ |  |
| `code_challenge` | query | `string` | ✓ | base64url(sha256(verifier))，无填充 |
| `code_challenge_method` | query | `string` = `S256` | ✓ |  |
| `redirect_uri` | query | `string` (uri) | ✓ | 回环地址，形如 http://127.0.0.1:<随机端口>/callback |
| `state` | query | `string` (uuid) | ✓ |  |


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` | 直接渲染一个确认页面（由页面自行提交后重定向） |
| `302` | 用户确认后重定向回 redirect_uri，带 code 与 state |




<a id="op-post-api-bridge-token"></a>

### POST /api/bridge/token

**用授权码换取 device_token**

bridge 拿到 `code` 后调用。**必须校验 code_verifier 满足 S256**：`base64url(sha256(code_verifier)) === 之前下发的 code_challenge`。

**请求体**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | `string` | ✓ |  |
| `code_verifier` | `string` | ✓ |  |
| `redirect_uri` | `string` (uri) | ✓ |  |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**示例**

```json
{
  "code": "string",
  "code_verifier": "string",
  "redirect_uri": "string",
  "client_id": "agent-bridge"
}
```


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` | 换取成功 |
| `400` | code / verifier 校验失败 |
| `404` | 平台未实现该端点（bridge 会提示"平台配套接口未上线"） |


**示例**

```json
{
  "device_token": "string",
  "device_id": "string",
  "refresh_token": "string"
}
```




<a id="op-post-api-bridge-device-code"></a>

### POST /api/bridge/device-code

**申请设备码**

无浏览器 / SSH 场景：返回一个短码 `user_code`，用户在别处确认。

**请求体**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**示例**

```json
{
  "client_id": "agent-bridge"
}
```


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` | 返回给用户的验证码与确认页 |
| `404` | 平台未实现该端点 |


**示例**

```json
{
  "device_code": "string",
  "user_code": "string",
  "verification_uri": "string"
}
```




<a id="op-post-api-bridge-device-token"></a>

### POST /api/bridge/device-token

**轮询设备码结果**

用户未确认时返回 4xx（bridge 按 `interval` 持续轮询直到 `expires_in`）；确认后返回与 `/api/bridge/token` 相同的结构。

**请求体**


| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `device_code` | `string` | ✓ |  |
| `client_id` | `string` = `agent-bridge` | ✓ |  |


**示例**

```json
{
  "device_code": "string",
  "client_id": "agent-bridge"
}
```


**响应**

| 状态码 | 含义 |
| --- | --- |
| `200` | 已确认 |
| `403` | 等待用户确认（bridge 继续轮询） |
| `404` | 平台未实现该端点 |
| `428` | 尚未确认（bridge 继续轮询） |


**示例**

```json
{
  "device_token": "string",
  "device_id": "string",
  "refresh_token": "string"
}
```



