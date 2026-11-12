/**
 * ComfyUI 侧边栏注册入口
 * 面板：导入分镜手册 → 解析成单元 → 一键写入提示词和参数
 */
import { app } from "../../scripts/app.js";
import { createStoryboardPanel } from "./storyboard_ui.js?v=20261112h";

const TAB_ICON_STYLE_ID = "sb-tab-icon-style";
const TAB_ICON_CSS = `
.sb-tab-icon{display:inline-flex;align-items:center;justify-content:center;}
.sb-tab-icon:before{content:"🎬";font-size:14px;line-height:1;}
`;

function ensureTabIcon() {
  if (document.getElementById(TAB_ICON_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TAB_ICON_STYLE_ID;
  style.textContent = TAB_ICON_CSS;
  document.head.appendChild(style);
}

app.registerExtension({
  name: "Storyboard.PromptPanel",
  async setup() {
    ensureTabIcon();

    if (!app.extensionManager || typeof app.extensionManager.registerSidebarTab !== "function") {
      console.warn("[分镜面板] 当前前端不支持 registerSidebarTab，请升级 ComfyUI 前端。");
      return;
    }

    app.extensionManager.registerSidebarTab({
      id: "storyboard-prompt-panel",
      icon: "sb-tab-icon",
      title: "分镜面板",
      tooltip: "导入分镜手册，按单元写入提示词与生成参数",
      type: "custom",
      render: (element) => {
        if (element.__storyboardPanel) {
          element.__storyboardPanel.refresh();
          return;
        }
        element.__storyboardPanel = createStoryboardPanel(element, app);
      },
    });
  },
});
