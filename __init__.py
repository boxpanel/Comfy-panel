"""分镜提示词面板（ComfyUI 自定义节点包）。

只提供前端侧边栏扩展：导入分镜手册（Markdown），解析成单元卡片，
再把提示词与档位参数写入当前工作流的对应节点。

安装时会把随包工作流（./workflows）复制到 ComfyUI 用户工作流目录，
同名文件已存在时跳过，避免覆盖用户改过的版本。

另外提供两个只读/下载型接口，用于补齐工作流缺失的模型文件：
  GET  /storyboard/models/status
  POST /storyboard/models/ensure

以及两个 git 更新接口（面板右上角的更新按钮用）：
  GET  /storyboard/update/status
  POST /storyboard/update/apply
"""

import asyncio
import logging
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./web"

# 版本号：与 pyproject.toml 的 [project] version 保持一致，发版时一起改
__version__ = "0.53.0"

PLUGIN_DIR = Path(__file__).parent

LOGGER = logging.getLogger("StoryboardPanel")


class StoryboardRefRuleBridge:
    """参考图规则桥：素材加载窗口 → 规则窗 → 参考图条件节点。

    节点只做 IMAGE 透传，`rules` 文本框保存分镜面板的参考图规则；
    素材必须经这个节点才能接到 Ref2V 的 Picture 1-9。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "rules": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "分镜面板的参考图规则，会同步进 Plan 的共享前缀",
                    },
                ),
            },
            "optional": {f"image_{index}": ("IMAGE",) for index in range(1, 10)},
        }

    RETURN_TYPES = ("IMAGE",) * 9
    RETURN_NAMES = tuple(f"image_{index}" for index in range(1, 10))
    FUNCTION = "passthrough"
    CATEGORY = "storyboard"
    DESCRIPTION = "把素材接入参考图条件的必经节点，同时保存本批参考图规则；没接图的一路输出空值，Ref2V 会跳过。"

    def passthrough(self, rules="", **images):
        return tuple(images.get(f"image_{index}") for index in range(1, 10))


# 规则桥节点 + 前端扩展
NODE_CLASS_MAPPINGS = {"StoryboardRefRuleBridge": StoryboardRefRuleBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"StoryboardRefRuleBridge": "参考图规则桥（Picture 1-9）"}

# 随包安装的配套工作流
BUNDLED_WORKFLOW_DIR = PLUGIN_DIR / "workflows"


def install_bundled_workflows():
    """把 ./workflows 里的工作流装进 ComfyUI 工作流列表；同名已存在则跳过。"""
    if not BUNDLED_WORKFLOW_DIR.is_dir():
        return []
    try:
        user_dir = Path(folder_paths.get_user_directory())
    except Exception:  # noqa: BLE001 - 老版本没有该接口时退回 base_path
        user_dir = Path(folder_paths.base_path) / "user"
    target_dir = user_dir / "default" / "workflows"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception as error:  # noqa: BLE001
        LOGGER.warning("[分镜面板] 无法创建工作流目录 %s：%s", target_dir, error)
        return []

    installed = []
    for source in sorted(BUNDLED_WORKFLOW_DIR.glob("*.json")):
        target = target_dir / source.name
        if target.exists():
            continue
        try:
            shutil.copy2(source, target)
            installed.append(source.name)
        except Exception as error:  # noqa: BLE001
            LOGGER.warning("[分镜面板] 工作流安装失败 %s：%s", source.name, error)
    if installed:
        LOGGER.info("[分镜面板] 已安装配套工作流：%s", "、".join(installed))
    return installed


INSTALLED_WORKFLOWS = install_bundled_workflows()

# 只允许下载这里登记过的文件，避免任意 URL 写入。
# aliases：工作流里常见的等价文件名片段，命中后前端会改指向 name。
MODEL_MANIFEST = [
    {
        "name": "minimax_h3_turbo_v4_step600_ema.safetensors",
        "folder": "loras",
        "url": "https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/minimax_h3_turbo_v4_step600_ema.safetensors",
        "size_mb": 800,
        "aliases": ["lightx2v_turbo", "fl2x_", "fl2x-"],
    },
]


def _model_roots(folder):
    roots = folder_paths.get_folder_paths(folder)
    if roots:
        return [Path(root) for root in roots]
    return [Path(folder_paths.models_dir) / folder]


def _target_path(folder, name):
    return _model_roots(folder)[0] / name


def _find_model(folder, name):
    for root in _model_roots(folder):
        path = root / name
        if path.is_file() and path.stat().st_size > 0:
            return path
    return None


def _model_status():
    items = []
    for item in MODEL_MANIFEST:
        found = _find_model(item["folder"], item["name"])
        items.append(
            {
                **item,
                "exists": found is not None,
                "path": str(found or _target_path(item["folder"], item["name"])),
            }
        )
    return items


def _lora_files():
    """列出所有 loras 目录下的文件（相对路径），供前端判断引用的文件是否已存在。"""
    files = set()
    for root in _model_roots("loras"):
        if not root.is_dir():
            continue
        for path in root.rglob("*.safetensors"):
            try:
                files.add(path.relative_to(root).as_posix())
            except ValueError:
                files.add(path.name)
    return sorted(files)


def _download(item):
    path = _target_path(item["folder"], item["name"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    request = urllib.request.Request(
        item["url"], headers={"User-Agent": "ComfyUI-StoryboardPanel/1.0"}
    )
    with urllib.request.urlopen(request, timeout=120) as response, open(tmp, "wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    os.replace(tmp, path)
    return path.stat().st_size


@PromptServer.instance.routes.get("/storyboard/models/status")
async def storyboard_models_status(request):
    return web.json_response({"items": _model_status(), "loras": _lora_files()})


@PromptServer.instance.routes.post("/storyboard/models/ensure")
async def storyboard_models_ensure(request):
    results = []
    for item in _model_status():
        if item["exists"]:
            results.append({**item, "status": "skipped"})
            continue
        try:
            size = await asyncio.to_thread(_download, item)
            results.append({**item, "exists": True, "status": "downloaded", "bytes": size})
        except Exception as error:  # noqa: BLE001 - 网络错误要原样报给前端
            results.append({**item, "status": "error", "error": str(error)})
    return web.json_response({"items": results})


# ---------- 面板内更新（只动插件自己的目录，来源是仓库 origin） ----------

def _git(args, timeout=90):
    """在插件目录里执行 git；禁用交互，没凭据时直接失败而不是卡住。"""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    return subprocess.run(
        ["git", "-C", str(PLUGIN_DIR), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def _update_status():
    if not (PLUGIN_DIR / ".git").exists():
        return {"ok": False, "git": False, "message": "当前不是 git 安装（zip 装的），无法自动更新"}
    try:
        fetch = _git(["fetch", "--quiet"])
        if fetch.returncode != 0:
            return {
                "ok": False,
                "git": True,
                "message": (fetch.stderr or fetch.stdout or "拉取远端失败").strip()[:300],
            }
        head = _git(["rev-parse", "--short", "HEAD"]).stdout.strip()
        counts = _git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]).stdout.split()
        ahead, behind = (int(counts[0]), int(counts[1])) if len(counts) == 2 else (0, 0)
        dirty = bool(_git(["status", "--porcelain"]).stdout.strip())
        return {"ok": True, "git": True, "head": head, "ahead": ahead, "behind": behind, "dirty": dirty}
    except FileNotFoundError:
        return {"ok": False, "git": False, "message": "服务器没有安装 git"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "git": True, "message": "git 超时（检查服务器到 GitHub 的网络）"}
    except Exception as error:  # noqa: BLE001 - 原样报给前端
        return {"ok": False, "git": True, "message": str(error)[:300]}


def _update_apply():
    status = _update_status()
    if not status.get("ok"):
        return {"ok": False, "message": status.get("message", "无法检查更新")}
    if status.get("dirty"):
        return {"ok": False, "message": "插件目录有本地修改，先还原或提交后再更新"}
    if not status.get("behind"):
        return {"ok": True, "changed": [], "message": f"已是最新版本（{status.get('head')}）"}
    before = _git(["rev-parse", "HEAD"]).stdout.strip()
    pull = _git(["pull", "--ff-only"])
    if pull.returncode != 0:
        return {"ok": False, "message": (pull.stderr or pull.stdout or "git pull 失败").strip()[:300]}
    after = _git(["rev-parse", "HEAD"]).stdout.strip()
    changed = [line.strip() for line in _git(["diff", "--name-only", before, after]).stdout.splitlines() if line.strip()]
    return {
        "ok": True,
        "before": before[:7],
        "after": after[:7],
        "changed": changed,
        "restart": "__init__.py" in changed,
        "message": f"已更新 {before[:7]} → {after[:7]}",
    }


@PromptServer.instance.routes.get("/storyboard/update/status")
async def storyboard_update_status(request):
    return web.json_response(await asyncio.to_thread(_update_status))


@PromptServer.instance.routes.post("/storyboard/update/apply")
async def storyboard_update_apply(request):
    return web.json_response(await asyncio.to_thread(_update_apply))


__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]
