import { App, EventRef, Platform, TFile, debounce } from "obsidian";
import Manager from "../main";
import { RibbonItem } from "../data/types";
import { RibbonNativeItem, WorkspaceWithRibbon } from "../obsidian-internals";

export interface RibbonConfig {
    hiddenItems: { [id: string]: boolean };
}

/**
 * 身份匹配的候选信息，桌面/平板（内存项）与手机（菜单项）共用
 * Match descriptor shared by desktop/tablet (memory item) and phone (menu item).
 */
export interface RibbonMatchTarget {
    /** 元素上已有的 bpmUniqueId；为空说明这个图标尚未被托管 */
    bpmUniqueId?: string | null;
    /** Obsidian 内存项 id，形如 "nutstore-sync:开始同步"（随语言/标题变化） */
    ribbonItemId?: string | null;
    /** 显示名称（aria-label / 菜单标题） */
    title?: string | null;
    /** 同一插件内的出现序号（从 1 开始；无法计算时传 null） */
    sequence?: number | null;
}

export class SystemRibbonManager {
    private app: App;
    private manager: Manager;
    private configPath: string;
    // 以下两个字段仅供已注释的 startWatch 使用，随其一同注释保留
    // private isInternalUpdate = false;
    // private onConfigChange: () => void = () => undefined;
    // fileWatcher 仍被 stopWatch 使用，保留
    private fileWatcher: EventRef | null = null;

    constructor(app: App, manager: Manager) {
        this.app = app;
        this.manager = manager;
        // 自动判定配置文件路径
        this.configPath = Platform.isMobile
            ? `${this.app.vault.configDir}/workspace-mobile.json`
            : `${this.app.vault.configDir}/workspace.json`; // 默认路径，可能会根据 configDir 变化

        // 更严谨的路径获取
        if (this.app.vault.configDir) {
            this.configPath = Platform.isMobile
                ? `${this.app.vault.configDir}/workspace-mobile.json`
                : `${this.app.vault.configDir}/workspace.json`;
        }
    }

    // ==================== 身份解析与匹配（唯一实现，禁止在调用方重复） ====================

    /**
     * 取出 ribbon 项 id 中的插件 id 前缀（与语言、标题无关）
     * @param itemId 内存项 id，形如 "nutstore-sync:开始同步"
     */
    public static pluginIdOf(itemId?: string | null): string {
        if (!itemId) return "";
        const index = itemId.indexOf(":");
        return index === -1 ? itemId : itemId.slice(0, index);
    }

    /**
     * 由插件 id 与序号生成候选 bpmUniqueId
     * 与历史数据保持一致：首个为裸前缀，其后为「前缀#序号」
     */
    public static candidateId(pluginId: string, sequence: number): string {
        if (!pluginId) return "";
        return sequence <= 1 ? pluginId : `${pluginId}#${sequence}`;
    }

    /**
     * 读取内存中的 ribbon 项（过滤 null/undefined，Obsidian 内部数组可能含空洞）
     */
    private getMemoryItems(): RibbonNativeItem[] {
        const items = (this.app.workspace as WorkspaceWithRibbon).leftRibbon?.items || [];
        return items.filter((item): item is RibbonNativeItem => Boolean(item));
    }

    /**
     * 统计某个内存项在其插件的 ribbon 项中的序号（从 1 开始）
     * 未命中返回 0；序号是「插件id+序号」匹配的关键，必须与历史分配规则一致
     */
    private sequenceOf(items: RibbonNativeItem[], target: RibbonNativeItem): number {
        const pluginId = SystemRibbonManager.pluginIdOf(target.id);
        if (!pluginId) return 0;
        const siblings = items.filter((item) => SystemRibbonManager.pluginIdOf(item.id) === pluginId);
        return siblings.indexOf(target) + 1;
    }

    /**
     * 建立已保存配置的多路索引，供身份恢复与元素匹配复用
     * 索引键：uid(精确身份) / seq(插件id+序号) / rid(ribbonIdMap 记录的内存项 id) / name(名称)
     */
    private buildSavedIndex(saved: RibbonItem[]): Map<string, RibbonItem> {
        const index = new Map<string, RibbonItem>();
        (saved || []).forEach((item) => {
            if (!item) return;

            if (item.bpmUniqueId) {
                index.set(`uid:${item.bpmUniqueId}`, item);
                // bpmUniqueId 本身即「插件id」或「插件id#序号」，可直接作为序号键使用
                index.set(`seq:${item.bpmUniqueId}`, item);
            }
            if (item.ribbonIdMap) {
                Object.values(item.ribbonIdMap).forEach((id) => {
                    if (id) index.set(`rid:${id}`, item);
                });
            }
            if (item.name) {
                index.set(`name:${item.name}`, item);
            }
        });
        return index;
    }

    /**
     * 名称匹配：单行要求完全相等；多行要求每一行都被包含（沿用既有约定）
     */
    private titleMatchesName(label: string, itemName: string): boolean {
        const lines = itemName.split("\n").map((line) => line.trim()).filter((line) => line !== "");
        if (lines.length <= 1) return label === itemName;
        return lines.every((line) => label.includes(line));
    }

    /**
     * 为内存中的 ribbon 项补齐 bpmUniqueId（幂等）
     * 插件重载/更新会重建 buttonEl 并丢失 dataset，身份必须由本方法重建，否则只能靠名称硬猜
     * 匹配优先级：ribbonIdMap(跨语言) → 插件id+序号 → 名称 → 新生成
     * @returns 是否存在新分配的身份
     */
    public assignMissingIds(saved: RibbonItem[]): boolean {
        const index = this.buildSavedIndex(saved);
        const items = this.getMemoryItems();
        const counters = new Map<string, number>();
        let changed = false;

        items.forEach((item) => {
            const buttonEl = item.buttonEl as HTMLElement | undefined;
            if (!buttonEl) return;

            const pluginId = SystemRibbonManager.pluginIdOf(item.id);
            // 序号必须在跳过判断之前累加，否则已有身份的项会打乱后续序号
            const sequence = (counters.get(pluginId) || 0) + 1;
            counters.set(pluginId, sequence);

            if (buttonEl.dataset?.bpmUniqueId) return;

            const matched =
                (item.id ? index.get(`rid:${item.id}`) : undefined) ||
                (pluginId ? index.get(`seq:${SystemRibbonManager.candidateId(pluginId, sequence)}`) : undefined) ||
                (item.title ? index.get(`name:${item.title}`) : undefined);

            const assigned = matched?.bpmUniqueId || SystemRibbonManager.candidateId(pluginId, sequence);
            if (!assigned) return;

            buttonEl.dataset.bpmUniqueId = assigned;
            changed = true;
        });

        return changed;
    }

    /**
     * 解析目标对应的已保存配置项（桌面/平板/手机共用的唯一匹配实现）
     * 匹配优先级：bpmUniqueId → 插件id+序号 → ribbonIdMap → 名称
     */
    public matchSetting(target: RibbonMatchTarget, saved: RibbonItem[]): RibbonItem | undefined {
        const index = this.buildSavedIndex(saved);

        // 1. 已带身份：精确命中
        if (target.bpmUniqueId) {
            const hit = index.get(`uid:${target.bpmUniqueId}`);
            if (hit) return hit;
        }

        // 2. 插件 id + 序号：与语言、标题都无关，最稳定
        const pluginId = SystemRibbonManager.pluginIdOf(target.ribbonItemId);
        if (pluginId && target.sequence) {
            const hit = index.get(`seq:${SystemRibbonManager.candidateId(pluginId, target.sequence)}`);
            if (hit) return hit;
        }

        // 3. ribbonIdMap：记录了各语言下的内存项 id，切换语言后仍可命中
        if (target.ribbonItemId) {
            const hit = index.get(`rid:${target.ribbonItemId}`);
            if (hit) return hit;
        }

        // 4. 名称兜底
        if (target.title) {
            const hit = index.get(`name:${target.title}`);
            if (hit) return hit;
            return (saved || []).find((item) => item.name && this.titleMatchesName(target.title as string, item.name));
        }

        return undefined;
    }

    /**
     * 由 DOM 元素反查内存项并生成匹配描述（桌面端/平板端）
     * 反查用 buttonEl 全等比较，拿到的 id/序号是稳定身份
     */
    public describeElement(element: HTMLElement, label: string): RibbonMatchTarget {
        const items = this.getMemoryItems();
        const memoryItem = items.find((item) => item.buttonEl === element);

        return {
            bpmUniqueId: memoryItem?.buttonEl?.dataset?.bpmUniqueId ?? null,
            ribbonItemId: memoryItem?.id ?? null,
            title: label || null,
            sequence: memoryItem ? this.sequenceOf(items, memoryItem) : null
        };
    }

    /**
     * 由标题生成匹配描述（手机端菜单项没有 id/dataset，用标题反查内存项补齐身份）
     * @param ownUniqueId 菜单元素自身已带的身份（若有则优先）
     */
    public describeTitle(title: string, ownUniqueId?: string | null): RibbonMatchTarget {
        const items = this.getMemoryItems();
        const memoryItem = items.find((item) => item.title === title);

        return {
            bpmUniqueId: ownUniqueId || memoryItem?.buttonEl?.dataset?.bpmUniqueId || null,
            ribbonItemId: memoryItem?.id ?? null,
            title: title || null,
            sequence: memoryItem ? this.sequenceOf(items, memoryItem) : null
        };
    }

    /**
     * 读取配置
     * @returns 返回有序的 ID 列表和显隐状态 Map
     */
    public async load(): Promise<{ orderedIds: string[], hiddenStatus: Record<string, boolean> }> {
        try {
            const exists = await this.app.vault.adapter.exists(this.configPath);
            if (!exists) {
                console.warn(`[BPM] Workspace config not found at ${this.configPath}`);
                return { orderedIds: [], hiddenStatus: {} };
            }

            const content = await this.app.vault.adapter.read(this.configPath);
            const json = JSON.parse(content);
            const leftRibbon = json["left-ribbon"];

            if (!leftRibbon || !leftRibbon.hiddenItems) {
                return { orderedIds: [], hiddenStatus: {} };
            }

            // 在 JS 引擎中，和 JSON 标准中，Object.keys 的顺序对于非整数键通常是插入顺序。
            // Obsidian 利用这一特性来存储顺序。
            const hiddenItems = leftRibbon.hiddenItems;
            const orderedIds = Object.keys(hiddenItems);
            const hiddenStatus = hiddenItems;

            return { orderedIds, hiddenStatus };
        } catch (e) {
            console.error("[BPM] Failed to load workspace config", e);
            return { orderedIds: [], hiddenStatus: {} };
        }
    }

    // ===== 以下两个方法当前无调用方，暂注释保留，待 main 主分支合并后 review 再决定去留 =====
    // 说明：ribbon 布局已只存于 BPM 数据中，不再读写 workspace 配置，故 save / startWatch 失去用途。
    // 恢复时无需改动导入：debounce 与 TFile 仅为 startWatch 保留。
    //
    // /**
    //  * 保存配置
    //  * @param orderedIds 按期望顺序排列的 ID 列表
    //  * @param hiddenStatus 每个 ID 的显隐状态
    //  */
    // public async save(orderedIds: string[], hiddenStatus: Record<string, boolean>) {
    //     // 保留方法签名兼容旧调用，但不写入 Obsidian workspace 配置文件。
    //     if (this.manager.settings.DEBUG) {
    //         console.log("[BPM] Workspace config save skipped; ribbon layout is stored only in BPM data.", orderedIds, hiddenStatus);
    //     }
    // }
    //
    // /**
    //  * 启动文件监听
    //  * @param callback 配置变更时的回调
    //  */
    // public startWatch(callback: () => void) {
    //     this.onConfigChange = callback;
    //     // 使用 debounce 防止频繁触发
    //     const debouncedReload = debounce(() => {
    //         if (this.isInternalUpdate) return;
    //         console.log("[BPM] Detected workspace config change, reloading...");
    //         this.onConfigChange();
    //     }, 1000, true);
    //
    //     // 监听 vault 修改事件
    //     this.fileWatcher = this.app.vault.on("modify", (file) => {
    //         if (file instanceof TFile && file.path === this.configPath) {
    //             debouncedReload();
    //         }
    //     });
    // }

    // 仍被 onunload 与 refreshRibbonManagerFeature 调用，保留
    public stopWatch() {
        if (this.fileWatcher) {
            this.app.vault.offref(this.fileWatcher);
            this.fileWatcher = null;
        }
    }
}
