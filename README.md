# dsh-model-switchboard

DSH（DeepSeek Harness）的**模型开关**：在设置页多出一个「模型开关」分区，把 DSH 里所有 provider 和模型摊开，逐个或整组关掉，关掉的模型会从所有模型选择器里消失。

## 为什么需要它

DSH 内置的「Models」设置页只覆盖**在配置里声明过**的 provider。插件动态注册的那批——比如 `dsh-our-free-model` 带来的 `our-free-model`、`our-free-model-region`——在各个选择器里可见，却在内置页面上找不到，于是关不掉。

模型一多，输入框上方的选择器会长得没法看。这个插件补上那一块：

- 设置页「模型开关」列出**运行时段全部** provider 与模型
- **逐模型**开关 + **按 provider 整组**开关
- 关掉的模型立即从所有模型选择器消失——输入框上方、`/model` 弹窗、子代理模型设置，**不用刷新页面**
- 附带 `list_models` 工具：只读列出当前实际生效的模型

## 安装

在 DSH profile 的 `package.json` 里加依赖，三种源任选其一：

```json
"dependencies": {
  "dsh-model-switchboard": "^0.1.0"
}
```

```json
"dependencies": {
  "dsh-model-switchboard": "github:DriverWangNB/dsh-model-switchboard"
}
```

国内网络如果拉 GitHub 不稳，换成 Gitee 镜像（内容同步，同一个包）：

```json
"dependencies": {
  "dsh-model-switchboard": "git+https://gitee.com/link77/dsh-models-manager.git"
}
```

依赖的**键**必须是包名 `dsh-model-switchboard`，仓库名与包名一致；pnpm 认的是仓库里 `package.json` 的 `name`。

再把包名登记进 `dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "dsh-model-switchboard"
    ]
  }
}
```

然后 `pnpm install`，重启 DSH。

## 使用

**设置 → 模型开关**。

| 操作 | 结果 |
| --- | --- |
| 点 provider 开关（原本全开） | 整组关闭，组员一起显示关闭 |
| 点 provider 开关（原本整组关闭或部分显示） | 整组全部打开 |
| 点某个组员开关 | 只切换那一个 |
| 在整组关闭的状态下点某个组员 | 该组退出整组关闭，只有这个组员和组是开的 |

provider 开关有三种状态：**显示中**（蓝）、**部分显示**（橙，组里有模型被单独关掉）、**已关闭**。

开关状态存在 `~/.dsh/dsh-model-switchboard/disabled.json`，重启后保留。

> 从旧包名 `dsh-model-manager`（≤0.3.3）升级：状态目录一起改了名，旧的 `~/.dsh/dsh-model-manager/disabled.json` 不会被读取。想保留原来的关闭项，把那个文件复制到新目录即可；不复制就是全部重新打开。

## 工具

| 工具 | 说明 |
| --- | --- |
| `list_models` | 列出运行时段每个 provider 实际生效的模型数，并标出被隐藏的 |
| `dmm_probe` | 自检：插件是否加载、包装了几个 adapter、广播链路是否通 |

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-model-switchboard/state` | 当前开关状态与展示数据 |
| POST | `/api/dsh-model-switchboard/toggle` | 切换单个模型或整组 |
| POST | `/api/dsh-model-switchboard/bulk` | 批量切换 |
| POST | `/api/dsh-model-switchboard/reset` | 清空所有关闭项 |

## 工作原理

Host 半身用 `Proxy` 包住 `ctx.llm.adapters` 里每个 registration 的 `adapter`，**只替换 `reg.adapter`**，拦截 `listModels` / `listAllModels` 后按当前状态过滤——原 adapter 一个字节都不改。

这一点很关键：像 channel-pack 这类渠道的 adapter 本身就是 `Proxy`，直接改写它的方法会陷入无限递归（真机上表现为渠道报 `Maximum call stack size exceeded`）。

状态一变，插件广播 `llm/adapters-updated`。客户端的常驻模型目录（`ModelCatalogDirectory`）只在收到这个事件时才重拉；不广播的话，页面会一直用着启动时缓存的那份目录——看起来就像"开关没生效"。

关闭状态**不写进任何 provider 配置**，只影响运行时可见性，因此不会破坏既有配置。

## 开发

```bash
node --test host.test.mjs
```

离线回归测试，用假的 `ctx` / `llm` 覆盖过滤、整组联动、广播，以及 channel-pack 式 `Proxy` 形状。

## 许可

MIT
