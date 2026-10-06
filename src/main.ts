import { normalizePath, ObsidianProtocolData, Plugin, PluginManifest, Workspace } from 'obsidian';
import { DEFAULT_SETTINGS, ManagerSettings, PluginUpdateCheckMode, ReleaseCompatibilityMode } from './settings/data';
import { ManagerSettingTab } from './settings';
import { Translator } from './lang/inxdex';
import { ManagerModal } from './modal/manager-modal';
import Commands from './command';
import Agreement from 'src/agreement';
import { RepoResolver, ensureBpmTagExists, BPM_TAG_ID } from './repo-resolver';
import { Notice, Platform, requestUrl } from 'obsidian';
import { BetaSource, ManagerPlugin, BPM_IGNORE_TAG, EONDR_PLUGIN_TAG_ID } from './data/types';
import { runMigrations } from './migrations';
import { fetchReleaseVersions, installPluginFromGithub, installThemeFromGithub, ReleaseVersion, sanitizeRepo } from './github-install';
import { performSelfCheck } from './self-check';
import { SystemRibbonManager } from './manager/system-ribbon-manager';
import { RibbonItem } from './data/types';
import { markSourceInstalledRelease, sourceHasUpdate as sourceHasConfiguredUpdate, syncSourceReleaseCheck } from './source-release';
import { LeftRibbonLike, ObsidianAppWithInternals, ObsidianPluginRegistry, RibbonNativeItem, WindowWithMoment, WorkspaceWithRibbon } from './obsidian-internals';
import { RibbonModal } from './modal/ribbon-modal';
import { githubProxyEnabled, resolveGithubUrl } from './github-url';

type UpdateSource = 'official' | 'github' | 'unknown';
interface UpdateStatus {
    source: UpdateSource;
    localVersion?: string;
    remoteVersion?: string | null;
    remotePublishedAt?: string;
    hasUpdate?: boolean;
    message?: string;
    error?: string;
    checkedAt?: number;
    repo?: string | null;
    versions?: ReleaseVersion[];
    checkMode?: PluginUpdateCheckMode;
    updateDelayDays?: number;
}

interface PluginUpdateCheckOptions {
    updateCheckMode?: PluginUpdateCheckMode;
    compatibilityMode?: ReleaseCompatibilityMode;
    updateDelayDays?: number;
}

interface PluginUpdateCheckNoticeOptions extends PluginUpdateCheckOptions {
    onChecked?: (id: string) => void;
}

type PluginUpdateCheckRunOptions = PluginUpdateCheckOptions & {
    onProgress?: (id?: string) => void;
    isCancelled?: () => boolean;
};

const EONDR_PLUGIN_RULES = [
    { id: "i18n", repo: "eondrcode/obsidian-i18n" },
];
const EONDR_REPO_OWNER = "eondrcode";
const GITHUB_TOKEN_SECRET_ID = "github-token";

type SecretStorageLike = {
    setSecret?: (id: string, secret: string) => void;
    getSecret?: (id: string) => string | null;
    listSecrets?: () => string[];
    deleteSecret?: (id: string) => void;
    removeSecret?: (id: string) => void;
};

type CommunityPluginStatsEntry = Record<string, number | string | undefined>;

export default class Manager extends Plugin {
    public settings!: ManagerSettings;
    public managerModal: ManagerModal | null = null;
    public ribbonModal: RibbonModal | null = null;
    public appPlugins!: ObsidianPluginRegistry;
    public appWorkspace!: Workspace;
    public translator!: Translator; 

    public agreement!: Agreement;
    public repoResolver!: RepoResolver;
    public systemRibbonManager?: SystemRibbonManager;
    public updateStatus: Record<string, UpdateStatus> = {};
    private updateProgressNotice: Notice | null = null;


    // 拖拽隐藏功能相关状态
    private isRibbonDragging = false;
    private draggedRibbonItem: HTMLElement | null = null;
    private dragObserverCleanup: (() => void) | null = null;

    /** 卸载后禁止一切延迟回调再动 ribbon（避免在已卸载的插件上复活） */
    private isUnloaded = false;

    /** 原生条目创建入口的原始引用（挂钩子用），卸载时原样还原 */
    private ribbonAddItemOriginal: LeftRibbonLike["addRibbonItemButton"] | null = null;
    /** 新条目注册后的补应用防抖句柄 */
    private ribbonItemApplyTimer: number | null = null;
    /** 启动后分批加载的补应用句柄 */
    private ribbonSettleTimers: number[] = [];

    public async onload() {
        this.appPlugins = (this.app as ObsidianAppWithInternals).plugins;
        this.appWorkspace = this.app.workspace;

        console.log(`%c ${this.manifest.name} %c v${this.manifest.version} `, `padding: 2px; border-radius: 2px 0 0 2px; color: #fff; background: #5B5B5B;`, `padding: 2px; border-radius: 0 2px 2px 0; color: #fff; background: #409EFF;`);
        await this.loadSettings();
        let settingsDirty = false;
        const markSettingsDirty = () => {
            settingsDirty = true;
        };

        await runMigrations(this);
        // 首次安装或未设置语言时，自动跟随 Obsidian 语言
        if (!this.settings.LANGUAGE_INITIALIZED || !this.settings.LANGUAGE) {
            this.settings.LANGUAGE = this.getAppLanguage();
            this.settings.LANGUAGE_INITIALIZED = true;
            markSettingsDirty();
        }
        // 初始化语言系统
        this.translator = new Translator(this);
        let builtinTagsChanged = false;
        const tagCountBeforeBpmEnsure = this.settings.TAGS.length;
        ensureBpmTagExists(this);
        builtinTagsChanged = this.settings.TAGS.length !== tagCountBeforeBpmEnsure;

        // 确保 BPM Ignore 标签存在
        if (!this.settings.TAGS.some(t => t.id === BPM_IGNORE_TAG)) {
            this.settings.TAGS.push({
                id: BPM_IGNORE_TAG,
                name: this.translator.t("标签_BPM忽略_名称") || "BPM Ignored",
                color: "#6c757d" // 灰色
            });
            builtinTagsChanged = true;
        }
        if (!this.settings.TAGS.some(t => t.id === EONDR_PLUGIN_TAG_ID)) {
            this.settings.TAGS.push({
                id: EONDR_PLUGIN_TAG_ID,
                name: this.translator.t("标签_Eondr插件_名称") || "Eondr Plugin",
                color: "#B36BFF",
            });
            builtinTagsChanged = true;
        }
        const bpmRecordsChanged = this.ensureBpmTagAndRecords();
        const selfRecordChanged = this.ensureSelfPluginRecord({ save: false });
        if (this.normalizeBuiltinTagNames() || builtinTagsChanged || bpmRecordsChanged || selfRecordChanged) markSettingsDirty();

        this.repoResolver = new RepoResolver(this);

        // 一次性清理旧版本留下的 inline 覆盖（旧机制在元素上写 display/order，
        // 在线升级后若不剥掉会与 Obsidian 原生状态互相打架）
        this.clearLegacyRibbonOverrides();

        // 初始化侧边栏图标
        this.addRibbonIcon('folder-cog', this.translator.t('通用_管理器_文本'), () => { this.managerModal = new ManagerModal(this.app, this); this.managerModal.open(); });
        // 初始化设置界面
        this.addSettingTab(new ManagerSettingTab(this.app, this));
        const pluginsChanged = this.settings.DELAY
            ? this.enableDelay({ save: false })
            : this.disableDelay({ save: false });
        if (pluginsChanged) markSettingsDirty();
        Commands(this.app, this);

        if (settingsDirty) {
            await this.saveSettings();
        }

        this.agreement = new Agreement(this);
        void this.startupCheckForUpdates();
        void this.startupMaintainBetaSources();

        this.registerObsidianProtocolHandler("BPM-plugin-install", (params: ObsidianProtocolData) => {
            void this.agreement.parsePluginInstall(params);
        });
        this.registerObsidianProtocolHandler("BPM-plugin-github", (params: ObsidianProtocolData) => {
            void this.agreement.parsePluginGithub(params);
        });

        this.app.workspace.onLayoutReady(() => {
            this.startRibbonRuntimeFeatures();

            // 延迟加载的插件可能带来新图标，需要登记进 RIBBON_SETTINGS；
            // 显隐与顺序由 Obsidian 原生状态承载，这里只补登记，不再需要「重绘后重新打补丁」
            this.registerEvent(this.app.workspace.on("layout-change", () => {
                if (this.isRibbonManagerEnabled()) this.applyRibbonSettings();
            }));

            // 延迟启动自检，确保 Obsidian 初始化完成，避免自动接管被覆盖
            window.setTimeout(() => {
                if (this.settings.DELAY) void performSelfCheck(this);
            }, 2000);
        });
    }

    public onunload() {
        // 卸载后一切延迟回调必须停手，否则会在已卸载的插件上继续操作 ribbon
        this.isUnloaded = true;
        this.stopRibbonRuntimeFeatures();

        // 注意：卸载时【绝不】改动插件的启用状态。
        // 卸载无法区分「App 退出 / 插件重载 / 用户停用 BPM」三种情形，
        // 而「把延迟插件交回 Obsidian 托管」本质上等同于把延时开关关掉：
        // 它会把全部延迟插件写进 community-plugins.json（enablePluginAndSave 会落盘），
        // 于是每次重载 BPM 都会改写用户配置、让 Obsidian 直接启动这些插件，
        // 延时启动随之失效，并被 BPM 自检报成「非 BPM 管理的插件」。
        // 交接只在用户显式关闭延时开关时进行（见 disableDelaysForAllPlugins 的调用点）。
    }

    private setupDragToHideObserver() {
        if (!this.isRibbonManagerEnabled() || this.dragObserverCleanup) return;

        const handlePointerDown = (e: PointerEvent) => {
            if (!this.isRibbonManagerEnabled()) return;
            const target = e.target as HTMLElement;
            // 检查是否是 Ribbon Icon
            if (target && target.closest && target.closest('.side-dock-ribbon-action')) {
                this.isRibbonDragging = true;
                this.draggedRibbonItem = target.closest('.side-dock-ribbon-action') as HTMLElement;
            }
        };

        const handlePointerUp = (e: PointerEvent) => {
            void this.handleRibbonPointerUp(e);
        };

        // 使用 capture 捕获事件，确保不被 Obsidian 内部拦截
        activeDocument.addEventListener('pointerdown', handlePointerDown, true);
        activeDocument.addEventListener('pointerup', handlePointerUp, true);

        this.dragObserverCleanup = () => {
            activeDocument.removeEventListener('pointerdown', handlePointerDown, true);
            activeDocument.removeEventListener('pointerup', handlePointerUp, true);
        };
    }

    /**
     * 一次性清理旧版本留下的 inline 覆盖
     * 旧机制把 display / order 写在元素 style 上并留 data-bpm-* 标记；
     * 新机制改用 Obsidian 原生状态承载，这些残留必须剥掉，否则两边互相打架
     */
    private clearLegacyRibbonOverrides() {
        activeDocument
            .querySelectorAll<HTMLElement>('[data-bpm-ribbon-managed], [data-bpm-menu-managed]')
            .forEach((element) => {
                const originalDisplay = element.getAttribute("data-bpm-original-display");
                const originalOrder = element.getAttribute("data-bpm-original-order");

                if (originalDisplay !== null) element.style.display = originalDisplay;
                else element.style.removeProperty("display");

                if (originalOrder !== null) element.style.order = originalOrder;
                else element.style.removeProperty("order");

                element.removeAttribute("data-bpm-ribbon-managed");
                element.removeAttribute("data-bpm-menu-managed");
                element.removeAttribute("data-bpm-original-display");
                element.removeAttribute("data-bpm-original-order");
            });
    }

    /** 取左ribbon 的原生对象（显隐与顺序的唯一载体） */
    private getLeftRibbon(): LeftRibbonLike | undefined {
        return (this.app.workspace as WorkspaceWithRibbon).leftRibbon;
    }

    /**
     * 应用 Ribbon 设置（唯一入口）
     *
     * 机制：把设置写进 Obsidian 原生状态 —— `items[].hidden` 与 `items` 顺序，
     * 再交给 `leftRibbon.onChange()` 重绘与持久化。原生状态由 Obsidian 自己维护，
     * 插件开关、界面重绘都不需要 BPM 重新打补丁，因此不再需要 DOM 观察器与自愈重试。
     *
     * 顺序权威属于 BPM 面板：在侧边栏直接用 Obsidian 原生拖拽排序，会被下一次应用覆盖。
     *
     * @param options.notify 为真时弹出结果提示（命令面板路径使用）
     */
    public applyRibbonSettings(options: { notify?: boolean } = {}): void {
        if (this.isUnloaded) return;
        if (!this.isRibbonManagerEnabled()) return;

        try {
            const ribbon = this.getLeftRibbon();
            if (!ribbon || !Array.isArray(ribbon.items) || typeof ribbon.onChange !== "function") {
                // 原生接口缺失（Obsidian 大版本变更）时降级为只读，绝不猜测 DOM
                console.error("[BPM] leftRibbon native API unavailable; ribbon settings not applied.");
                if (options.notify) new Notice(this.translator.t("Ribbon_原生接口不可用"));
                return;
            }

            this.cleanRibbonItems();

            const items = (ribbon.items || []).filter((item): item is RibbonNativeItem => Boolean(item));
            const saved = this.settings.RIBBON_SETTINGS || (this.settings.RIBBON_SETTINGS = []);

            if (items.length === 0) return;

            this.ensureSystemRibbonManager();
            const resolutions = this.systemRibbonManager?.resolve(saved, items) || [];

            // 1. 登记 BPM 尚未见过的新图标；同步已登记条目漂移掉的标识字段
            let settingsDirty = false;
            let nextOrder = this.nextRibbonOrder(saved);
            resolutions.forEach((resolution) => {
                if (!resolution.setting) {
                    const setting = this.buildRibbonSetting(resolution.item, nextOrder++, resolution.sequence);
                    saved.push(setting);
                    resolution.setting = setting;
                    settingsDirty = true;
                    if (this.settings.DEBUG) {
                        console.log("[BPM] Ribbon item registered as new", setting.bpmUniqueId, resolution.item.id);
                    }
                } else if (resolution.identityDrifted) {
                    this.syncRibbonSettingIdentity(resolution.setting, resolution.item);
                    settingsDirty = true;
                }
            });
            if (settingsDirty) void this.saveSettings();

            // 2. 写原生状态：BPM 权威，覆盖原生显隐与顺序
            let ribbonChanged = false;
            resolutions.forEach((resolution) => {
                const setting = resolution.setting;
                if (!setting) return;
                const hidden = setting.visible === false;
                if (resolution.item.hidden !== hidden) {
                    resolution.item.hidden = hidden;
                    ribbonChanged = true;
                }
            });

            const ordered = resolutions
                .slice()
                .sort((a, b) => this.ribbonOrderOf(a.setting) - this.ribbonOrderOf(b.setting))
                .map((resolution) => resolution.item);

            if (!this.sameRibbonOrder(items, ordered)) {
                // 原地改写数组，保持 Obsidian 持有的引用不变（onChange 读的就是它）
                ribbon.items?.splice(0, ribbon.items.length, ...ordered);
                ribbonChanged = true;
            }

            // 3. 只在确有变化时重绘；持久化走唯一路径 persistRibbonConfigFile，
            //    不调用 onChange(true)，避免与 Obsidian 自身的布局保存形成两个写入者
            if (ribbonChanged) ribbon.onChange(false);
            void this.persistRibbonConfigFile();

            if (options.notify) {
                new Notice(
                    this.translator.t("command_notice_ribbon_settings_applied", { count: saved.length })
                );
            }
        } catch (error) {
            console.error("[BPM] applyRibbonSettings failed:", error);
        }
    }

    /**
     * 兼容别名：显隐与顺序的应用统一走 applyRibbonSettings
     * 保留该名字以免改动既有调用点
     */
    public updateRibbonStyles() {
        this.applyRibbonSettings();
    }

    // ==================== 新条目的补应用与持久化 ====================

    /**
     * 挂上「条目创建」钩子：任何 ribbon 图标被注册之后重新应用一次设置
     *
     * 为什么必须挂在这里：新条目出生时 `hidden` 默认 false，而 Obsidian 只在启动时
     * 按配置 `load()` 一次，此后整个会话都不会再复述配置（实测 11 秒内 load/onChange 均 0 次）。
     * 因此唯一可靠的时机就是「条目刚被创建」这一刻 —— 无论它由谁触发
     * （BPM 的延时启动、Obsidian 自带的插件开关、别的插件动态注册）。
     *
     * 这也是替代已删除的 DOM 观察器的结构性钩子：它只在条目创建时触发，
     * 不随容器重建而失效，也不会被无关的 DOM 变动刷屏。
     */
    private installRibbonItemHook(): void {
        const ribbon = this.getLeftRibbon();
        if (!ribbon || typeof ribbon.addRibbonItemButton !== "function") return;
        if (this.ribbonAddItemOriginal) return;

        const original = ribbon.addRibbonItemButton.bind(ribbon) as LeftRibbonLike["addRibbonItemButton"];
        this.ribbonAddItemOriginal = original;
        ribbon.addRibbonItemButton = (...args: Parameters<NonNullable<LeftRibbonLike["addRibbonItemButton"]>>) => {
            const result = original?.(...args);
            this.scheduleRibbonApplyAfterItemAdded();
            return result as HTMLElement;
        };
    }

    /** 还原原生创建入口（卸载/关闭接管时） */
    private removeRibbonItemHook(): void {
        const ribbon = this.getLeftRibbon();
        if (ribbon && this.ribbonAddItemOriginal) {
            ribbon.addRibbonItemButton = this.ribbonAddItemOriginal;
        }
        this.ribbonAddItemOriginal = null;
    }

    /**
     * 条目创建后的补应用（防抖）
     * 启动时几十个插件会连续注册图标，合并成一次应用；200ms 也留出了
     * 插件在 addRibbonIcon 之后继续改标题/图标的余量
     */
    private scheduleRibbonApplyAfterItemAdded(): void {
        if (this.isUnloaded) return;
        if (this.ribbonItemApplyTimer !== null) window.clearTimeout(this.ribbonItemApplyTimer);
        this.ribbonItemApplyTimer = window.setTimeout(() => {
            this.ribbonItemApplyTimer = null;
            this.applyRibbonSettings();
        }, 200);
    }

    /**
     * 启动后的几次兜底应用：延时启动的插件分批到位，且钩子万一在新版本里失效时
     * 仍能收敛。次数固定、自动结束，不做常驻轮询。
     */
    private scheduleStartupSettleApplies(): void {
        [3000, 8000, 15000].forEach((delay) => {
            const handle = window.setTimeout(() => {
                this.ribbonSettleTimers = this.ribbonSettleTimers.filter((item) => item !== handle);
                if (this.isUnloaded) return;
                this.applyRibbonSettings();
            }, delay);
            this.ribbonSettleTimers.push(handle);
        });
    }

    /**
     * 把当前 ribbon 状态直写进 Obsidian 的配置文件（只改 left-ribbon 段）
     *
     * 为什么要直写：原生持久化依赖 `requestSaveLayout()` 的防抖与退出时机，
     * 一旦那次写入没落地，下次启动 Obsidian 会按过期的 `hiddenItems` 复述一遍，
     * 于是「启动后设置不生效」。直写让我们期望的状态成为磁盘上的事实，
     * 启动时由 Obsidian 自己的 `load()` 应用。
     *
     * 安全约束：重新读盘后再写、只替换 left-ribbon 一个键、与现有内容一致时完全不写
     * （避免整文件 diff 与 git 噪声）；按平台选 workspace(-mobile).json。
     */
    private async persistRibbonConfigFile(): Promise<void> {
        if (this.isUnloaded) return;
        const ribbon = this.getLeftRibbon();
        if (!ribbon || typeof ribbon.serialize !== "function") return;

        const configPath = `${this.app.vault.configDir}/${Platform.isMobile ? "workspace-mobile.json" : "workspace.json"}`;
        try {
            const adapter = this.app.vault.adapter;
            if (!(await adapter.exists(configPath))) return;

            const desired = ribbon.serialize();
            const raw = await adapter.read(configPath);
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (JSON.stringify(parsed["left-ribbon"]) === JSON.stringify(desired)) return;

            parsed["left-ribbon"] = desired;
            await adapter.write(configPath, JSON.stringify(parsed, null, 2));
            if (this.settings.DEBUG) {
                console.log("[BPM] Ribbon state written to", configPath);
            }
        } catch (error) {
            console.error("[BPM] persist ribbon config failed:", error);
        }
    }

    /** 配置项的排序键：非法 order 视为末尾（与旧机制 order=9999 的语义一致） */
    private ribbonOrderOf(setting?: RibbonItem): number {
        const order = setting?.order;
        return setting && Number.isFinite(order) ? (order as number) : Number.MAX_SAFE_INTEGER;
    }

    /** 下一个可用的顺序号（新项排在末尾） */
    private nextRibbonOrder(saved: RibbonItem[]): number {
        return saved.reduce(
            (max, item) => (item && Number.isFinite(item.order) ? Math.max(max, item.order) : max),
            -1
        ) + 1;
    }

    /** 两个内存项数组的顺序是否完全一致 */
    private sameRibbonOrder(a: RibbonNativeItem[], b: RibbonNativeItem[]): boolean {
        if (a.length !== b.length) return false;
        return a.every((item, index) => item === b[index]);
    }

    /**
     * 同步已保存条目的标识字段（只动 name / ribbonIdMap，绝不动 visible / order）
     * 标识字段是后续匹配的依据：插件改了标题或换了内存项 id 后，靠它重新对上
     */
    private syncRibbonSettingIdentity(setting: RibbonItem, item: RibbonNativeItem) {
        if (item.title && setting.name !== item.title) {
            setting.name = item.title;
        }
        if (!item.id) return;

        const ribbonIdMap = setting.ribbonIdMap || (setting.ribbonIdMap = {});
        const alreadyRecorded = Object.values(ribbonIdMap).includes(item.id);
        if (alreadyRecorded) return;

        // 语言键只影响「切语言后能否回填」，记录过就不必重复写
        if (this.usesChineseRibbonIdMap()) ribbonIdMap.zh = item.id;
        else ribbonIdMap.en = item.id;
    }

    /**
     * 由内存项构造配置项（新登记的项默认显示、排在末尾）
     * @param order 分配给该项的顺序
     * @param sequence 同一插件内的出现序号，用于生成候选身份
     * @param previous 已保存的旧项，存在时保留用户的 visible / order
     */
    private buildRibbonSetting(
        item: RibbonNativeItem,
        order: number,
        sequence = 1,
        previous?: RibbonItem
    ): RibbonItem {
        const ribbonIdMap: RibbonItem["ribbonIdMap"] = {};
        if (this.usesChineseRibbonIdMap()) {
            ribbonIdMap.zh = item.id;
        } else {
            ribbonIdMap.en = item.id;
        }

        const pluginId = SystemRibbonManager.pluginIdOf(item.id);
        const taken = new Set((this.settings.RIBBON_SETTINGS || []).map((entry) => entry?.bpmUniqueId));
        const bpmUniqueId = previous?.bpmUniqueId || this.uniqueRibbonId(pluginId, sequence, taken);

        return {
            bpmUniqueId,
            name: item.title || previous?.name || "",
            icon: item.icon || previous?.icon || "help-circle",
            visible: previous ? previous.visible : true,
            order: previous ? previous.order : order,
            ribbonIdMap
        };
    }

    /**
     * 生成不冲突的身份：首选「插件id」或「插件id#序号」，被占用则顺延
     * 冲突时顺延而不是覆盖，避免两个图标共用同一身份
     */
    private uniqueRibbonId(pluginId: string, sequence: number, taken: Set<string | undefined>): string {
        const preferred = SystemRibbonManager.candidateId(pluginId, sequence);
        if (preferred && !taken.has(preferred)) return preferred;

        for (let index = Math.max(sequence, 2); index < 1000; index++) {
            const candidate = pluginId ? `${pluginId}#${index}` : "";
            if (candidate && !taken.has(candidate)) return candidate;
        }
        return preferred || `ribbon-${Date.now()}`;
    }

    /**
     * ribbonIdMap 的写入分支：沿用既有约定（按 Obsidian 语言判断）
     */
    private usesChineseRibbonIdMap(): boolean {
        const currentLang = (this.app.vault as { getConfig?: (key: string) => string }).getConfig?.("language") || "en";
        return currentLang.startsWith("zh");
    }

    private async handleRibbonPointerUp(e: PointerEvent) {
            if (!this.isRibbonManagerEnabled()) {
                this.isRibbonDragging = false;
                this.draggedRibbonItem = null;
                return;
            }
            if (!this.isRibbonDragging || !this.draggedRibbonItem) {
                this.isRibbonDragging = false;
                this.draggedRibbonItem = null;
                return;
            }

            // 获取 Ribbon 容器位置
            const container = activeDocument.querySelector('.side-dock-actions');
            if (container) {
                const rect = container.getBoundingClientRect();
                // 允许一定的误差范围（缓冲区的宽度/高度），可以设大一点，比如 50px
                const buffer = 50;

                // 判断是否明显拖到了外部
                // 只要鼠标松开的位置超出了 Ribbon 容器的范围，就视为删除
                const isOutside = (
                    e.clientX > rect.right + buffer ||
                    e.clientX < rect.left - buffer || // 左侧通常不可能，除非浮动
                    e.clientY < rect.top - buffer ||  // 向上拖出
                    e.clientY > rect.bottom + buffer  // 向下拖出 (Settings 区域通常接着 Actions，所以向下拖可能还在侧边栏内，这里需要 careful)
                );

                // 如果向下拖到了 Settings 按钮上，可能会误判。
                // 最好是检测是否拖到了 编辑器区域 (main-content).
                // 简单点: x > rect.right + buffer 实际上是最常见的“拖出”行为。

                if (isOutside) {
                    const label = this.draggedRibbonItem.getAttribute('aria-label');
                    if (label) {
                        await this.hideRibbonItemByLabel(label);
                    }
                }
            }

            this.isRibbonDragging = false;
            this.draggedRibbonItem = null;
    }

    /**
     * 拖拽隐藏：按标题找到对应设置并置为隐藏
     * 真正的显隐由 applyRibbonSettings 写入 Obsidian 原生状态
     */
    private async hideRibbonItemByLabel(label: string) {
        if (!this.isRibbonManagerEnabled()) return;

        const items = this.settings.RIBBON_SETTINGS;
        const targetItem = items.find(i => i.name === label); // name 通常就是 label
        if (!targetItem) return;

        console.log(`[BPM] Drag-to-hide triggered for: ${label} (${targetItem.bpmUniqueId})`);
        targetItem.visible = false;

        await this.saveSettings();
        this.applyRibbonSettings();

        // 如果 BPM 设置面板打开着，尝试刷新它
        this.reloadIfCurrentModal();

        new Notice(this.translator.t("Ribbon_已隐藏_通知", { name: label }));
    }

    public isRibbonManagerEnabled(): boolean {
        return this.settings?.RIBBON_MANAGER_ENABLED !== false;
    }

    private ensureSystemRibbonManager() {
        if (!this.systemRibbonManager) this.systemRibbonManager = new SystemRibbonManager(this.app, this);
    }

    private stopRibbonRuntimeFeatures() {
        if (this.dragObserverCleanup) {
            this.dragObserverCleanup();
            this.dragObserverCleanup = null;
        }
        this.isRibbonDragging = false;
        this.draggedRibbonItem = null;

        this.removeRibbonItemHook();
        if (this.ribbonItemApplyTimer !== null) {
            window.clearTimeout(this.ribbonItemApplyTimer);
            this.ribbonItemApplyTimer = null;
        }
        this.ribbonSettleTimers.forEach((handle) => window.clearTimeout(handle));
        this.ribbonSettleTimers = [];
    }

    private startRibbonRuntimeFeatures() {
        if (!this.isRibbonManagerEnabled()) {
            this.stopRibbonRuntimeFeatures();
            return;
        }

        this.applyRibbonSettings();
        // 新条目一出生就复述设置：这是「插件开关后设置不生效」的结构性解法
        this.installRibbonItemHook();
        // 延时启动的插件分批到位，补几次兜底（固定次数，自动结束）
        this.scheduleStartupSettleApplies();
        // 手机端与桌面端的 ribbon 都源自同一份原生 items，显隐与顺序由原生状态承载，
        // 不再需要按平台分别操作 DOM；仅「拖出即隐藏」这一手势在手机端不适用
        if (!Platform.isPhone) this.setupDragToHideObserver();
    }

    public async refreshRibbonManagerFeature() {
        if (this.isRibbonManagerEnabled()) {
            this.startRibbonRuntimeFeatures();
        } else {
            this.stopRibbonRuntimeFeatures();
            this.systemRibbonManager = undefined;
            // 关闭接管 = 停止写入。原生状态无法与用户自己的改动区分，故不做回滚；
            // 只剥掉旧机制可能残留在元素上的 inline 覆盖
            this.clearLegacyRibbonOverrides();
            try {
                this.ribbonModal?.close?.();
            } catch {
                // ignore
            }
            this.ribbonModal = null;
        }

        try {
            await this.managerModal?.refreshRibbonFeatureAvailability?.();
        } catch {
            // ignore
        }
    }

    public async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    public async saveSettings() { await this.saveData(this.settings); }

    private getSecretStorage(): SecretStorageLike | null {
        const storage = (this.app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
        if (!storage || typeof storage.getSecret !== "function" || typeof storage.setSecret !== "function") return null;
        return storage;
    }

    public supportsSecretStorage(): boolean {
        return Boolean(this.getSecretStorage());
    }

    public async getGithubToken(): Promise<string | undefined> {
        if (githubProxyEnabled(this)) return undefined;

        const storage = this.getSecretStorage();
        const stored = storage?.getSecret?.(GITHUB_TOKEN_SECRET_ID)?.trim();
        if (stored) return stored;

        const legacy = this.settings.GITHUB_TOKEN?.trim();
        if (!legacy) return undefined;

        if (storage) {
            try {
                storage.setSecret?.(GITHUB_TOKEN_SECRET_ID, legacy);
                this.settings.GITHUB_TOKEN = "";
                await this.saveSettings();
            } catch (error) {
                if (this.settings.DEBUG) console.error("[BPM] migrate GitHub token to secret storage failed", error);
            }
        }
        return legacy;
    }

    public hasGithubToken(): boolean {
        if (githubProxyEnabled(this)) return false;
        return Boolean(this.getSecretStorage()?.getSecret?.(GITHUB_TOKEN_SECRET_ID)?.trim() || this.settings.GITHUB_TOKEN?.trim());
    }

    public async setGithubToken(token: string): Promise<void> {
        if (githubProxyEnabled(this)) return;
        const nextToken = token.trim();
        const storage = this.getSecretStorage();
        if (storage) {
            storage.setSecret?.(GITHUB_TOKEN_SECRET_ID, nextToken);
            this.settings.GITHUB_TOKEN = "";
        } else {
            this.settings.GITHUB_TOKEN = nextToken;
        }
        await this.saveSettings();
    }

    public async clearGithubToken(): Promise<void> {
        const storage = this.getSecretStorage();
        try {
            storage?.deleteSecret?.(GITHUB_TOKEN_SECRET_ID);
            storage?.removeSecret?.(GITHUB_TOKEN_SECRET_ID);
            storage?.setSecret?.(GITHUB_TOKEN_SECRET_ID, "");
        } catch (error) {
            if (this.settings.DEBUG) console.error("[BPM] clear GitHub token secret failed", error);
        }
        this.settings.GITHUB_TOKEN = "";
        await this.saveSettings();
    }

    // 保存单个插件配置。保留方法名以兼容旧调用点。
    public async savePluginAndExport(pluginId: string) {
        await this.saveSettings();
    }

    public showUpdateProgress(total: number): { dispose: () => void; update: (processed: number, currentId?: string) => void; cancel: () => void; isCancelled: () => boolean } {
        if (this.updateProgressNotice) this.updateProgressNotice.hide();
        const baseText = this.translator.t("通知_检测更新中文案");
        const notice = new Notice(baseText, 0);
        const update = (p: number, currentId?: string) => {
            notice.setMessage(`${baseText} ${Math.min(p, total)}/${total}${currentId ? ` · ${currentId}` : ""}`);
        };
        this.updateProgressNotice = notice;
        update(0);
        return {
            dispose: () => {
                notice.hide();
                if (this.updateProgressNotice === notice) this.updateProgressNotice = null;
            },
            update,
            cancel: () => undefined,
            isCancelled: () => false
        };
    }

    public getPluginUpdateCheckOptions(): Required<PluginUpdateCheckOptions> {
        return {
            updateCheckMode: this.normalizePluginUpdateCheckMode(this.settings.PLUGIN_UPDATE_CHECK_MODE),
            compatibilityMode: this.normalizeReleaseCompatibilityMode(this.settings.PLUGIN_UPDATE_COMPATIBILITY_MODE),
            updateDelayDays: this.normalizePluginUpdateDelayDays(this.settings.PLUGIN_UPDATE_DELAY_DAYS),
        };
    }

    public async setPluginUpdateCheckOptions(options: PluginUpdateCheckOptions): Promise<void> {
        this.settings.PLUGIN_UPDATE_CHECK_MODE = this.normalizePluginUpdateCheckMode(options.updateCheckMode);
        this.settings.PLUGIN_UPDATE_COMPATIBILITY_MODE = this.normalizeReleaseCompatibilityMode(options.compatibilityMode);
        this.settings.PLUGIN_UPDATE_DELAY_DAYS = this.normalizePluginUpdateDelayDays(options.updateDelayDays);
        await this.saveSettings();
    }

    public async checkUpdatesWithNotice(options: PluginUpdateCheckNoticeOptions = {}): Promise<Record<string, UpdateStatus>> {
        const { onChecked, ...checkOptions } = options;
        const manifests = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
        const progress = this.showUpdateProgress(manifests.length);
        let processed = 0;
        try {
            const res = await this.checkUpdates({
                ...checkOptions,
                onProgress: (id?: string) => {
                    processed++;
                    progress.update(processed, id);
                    if (id) onChecked?.(id);
                },
                isCancelled: () => progress.isCancelled()
            });
            return res;
        } finally {
            progress.dispose();
        }
    }

    private async startupCheckForUpdates() {
        if (!this.settings.STARTUP_CHECK_UPDATES) return;
        try {
            const manifests = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
            const progress = this.showUpdateProgress(manifests.length);
            let processed = 0;
            const status = await this.checkUpdates({
                onProgress: () => { processed++; progress.update(processed); },
                isCancelled: () => progress.isCancelled()
            });
            const count = Object.values(status || {}).filter(s => s.hasUpdate).length;
            if (count > 0) {
                const msg = this.translator.t("通知_可更新数量").replace("{count}", `${count}`);
                new Notice(msg, 5000);
            }
            progress.dispose();
        } catch (e) {
            if (this.settings.DEBUG) console.error("[BPM] startup check updates failed", e);
            if (!githubProxyEnabled(this) && !this.hasGithubToken()) {
                new Notice(this.translator.t("通知_检查更新失败_建议Token"));
            }
        }
    }

    private sourceHasUpdate(source: BetaSource): boolean {
        return sourceHasConfiguredUpdate(source);
    }

    private getBetaSourcePluginId(source: BetaSource): string {
        const mappedId = Object.entries(this.settings.REPO_MAP || {})
            .find(([, repo]) => sanitizeRepo(repo) === sanitizeRepo(source.repo))?.[0];
        if (mappedId) source.id = mappedId;
        return mappedId || source.id;
    }

    private async refreshBetaSourceInstalledAt(source: BetaSource): Promise<void> {
        const folder = source.type === "plugin"
            ? normalizePath(`${this.app.vault.configDir}/plugins/${this.getBetaSourcePluginId(source)}`)
            : normalizePath(`${this.app.vault.configDir}/themes/${source.id}`);
        try {
            const stat = await this.app.vault.adapter.stat(folder);
            source.installedAt = stat ? (stat.ctime || stat.mtime || undefined) : undefined;
        } catch {
            source.installedAt = undefined;
        }
    }

    private async checkBetaSource(source: BetaSource): Promise<void> {
        try {
            const versions = await fetchReleaseVersions(this, source.repo, { includeManifest: source.type === "plugin" });
            let localVersion = source.localVersion || "";
            if (source.type === "plugin") {
                const pluginId = this.getBetaSourcePluginId(source);
                localVersion = (this.appPlugins.manifests[pluginId] as PluginManifest | undefined)?.version || source.localVersion || "";
            }
            const releaseCheck = syncSourceReleaseCheck(source, versions, localVersion);
            if (source.mode === "frozen" && !source.frozenVersion) source.frozenVersion = releaseCheck.target?.tag;
            source.lastChecked = Date.now();
            source.error = "";
            await this.refreshBetaSourceInstalledAt(source);
        } catch (e) {
            source.error = (e as Error)?.message || String(e);
            source.lastChecked = Date.now();
            if (this.settings.DEBUG) console.error("[BPM] beta source check failed", source.repo, e);
        }
    }

    private async startupCheckBetaSources() {
        if (!this.settings.SOURCE_STARTUP_CHECK_UPDATES) return;

        const sources = (this.settings.BETA_SOURCES || []).filter(s => s.enabled);
        if (sources.length === 0) return;

        for (const source of sources) {
            await this.checkBetaSource(source);
        }

        await this.saveSettings();
        const count = sources.filter((source) => this.sourceHasUpdate(source)).length;
        if (count > 0) {
            new Notice(this.translator.t("通知_来源可更新数量", { count }), 5000);
        }
    }

    private async startupMaintainBetaSources() {
        await this.startupCheckBetaSources();
        await this.startupUpdateBetaSources();
    }

    private async startupUpdateBetaSources() {
        if (!this.settings.SOURCE_AUTO_UPDATE) return;

        const sources = (this.settings.BETA_SOURCES || []).filter(s => s.enabled && s.autoUpdate);
        if (sources.length === 0) return;
        for (const source of sources) {
            try {
                const checkedRecently = source.lastChecked && Date.now() - source.lastChecked < 60_000;
                let targetVersion = checkedRecently
                    ? source.latestReleaseTag || source.latestVersion || ""
                    : "";
                let targetPublishedAt = checkedRecently
                    ? source.latestReleasePublishedAt || source.latestPublishedAt
                    : undefined;
                if (!targetVersion) {
                    const versions = await fetchReleaseVersions(this, source.repo, { includeManifest: source.type === "plugin" });
                    let localVersion = source.localVersion || "";
                    if (source.type === "plugin") {
                        const pluginId = this.getBetaSourcePluginId(source);
                        localVersion = (this.appPlugins.manifests[pluginId] as PluginManifest | undefined)?.version || source.localVersion || "";
                    }
                    const releaseCheck = syncSourceReleaseCheck(source, versions, localVersion);
                    if (source.mode === "frozen" && !source.frozenVersion) source.frozenVersion = releaseCheck.target?.tag;
                    targetVersion = releaseCheck.target?.tag || "";
                    targetPublishedAt = releaseCheck.target?.publishedAt;
                    source.lastChecked = Date.now();
                    source.error = "";
                }

                if (!targetVersion) continue;
                const configuredTargetVersion = source.mode === "frozen"
                    ? source.frozenVersion || source.latestReleaseTag || source.latestVersion || ""
                    : source.latestReleaseTag || source.latestVersion || "";
                if (source.type === "plugin") {
                    const pluginId = this.getBetaSourcePluginId(source);
                    const localVersion = (this.appPlugins.manifests[pluginId] as PluginManifest | undefined)?.version || source.localVersion || "";
                    source.localVersion = localVersion;
                    const needsUpdate = sourceHasConfiguredUpdate(source);
                    if (needsUpdate && targetVersion === configuredTargetVersion) {
                        const ok = await installPluginFromGithub(this, source.repo, targetVersion, true);
                        if (ok) {
                            this.getBetaSourcePluginId(source);
                            const manifest = this.appPlugins.manifests[source.id] as PluginManifest | undefined;
                            markSourceInstalledRelease(source, targetVersion, targetPublishedAt, manifest?.version || targetVersion);
                        }
                    }
                } else {
                    const needsUpdate = sourceHasConfiguredUpdate(source);
                    if (needsUpdate && targetVersion === configuredTargetVersion) {
                        const ok = await installThemeFromGithub(this, source.repo, targetVersion);
                        if (ok) markSourceInstalledRelease(source, targetVersion, targetPublishedAt, targetVersion);
                    }
                }
                await this.refreshBetaSourceInstalledAt(source);
            } catch (e) {
                source.error = (e as Error)?.message || String(e);
                source.lastChecked = Date.now();
                if (this.settings.DEBUG) console.error("[BPM] beta source auto update failed", source.repo, e);
            }
        }
        await this.saveSettings();
    }

    public ensureBpmTagAndRecords(): boolean {
        const previousStateJson = JSON.stringify({
            TAGS: this.settings.TAGS,
            Plugins: this.settings.Plugins,
        });
        ensureBpmTagExists(this);
        // 确保 BPM 安装的插件拥有标签
        this.settings.BPM_INSTALLED.forEach((id) => {
            const mp = this.settings.Plugins.find(p => p.id === id);
            if (mp && !mp.tags.includes(BPM_TAG_ID)) mp.tags.push(BPM_TAG_ID);
        });
        this.settings.Plugins.forEach((plugin) => this.applySpecialPluginTags(plugin));
        const nextStateJson = JSON.stringify({
            TAGS: this.settings.TAGS,
            Plugins: this.settings.Plugins,
        });
        return previousStateJson !== nextStateJson;
    }

    private isEondrPlugin(pluginId: string): boolean {
        const normalizedId = pluginId.trim().toLowerCase();
        if (EONDR_PLUGIN_RULES.some((rule) => rule.id.toLowerCase() === normalizedId)) return true;

        const mappedRepo = sanitizeRepo(this.settings.REPO_MAP?.[pluginId] || "").toLowerCase();
        return Boolean(mappedRepo && (
            mappedRepo.startsWith(`${EONDR_REPO_OWNER}/`)
            || EONDR_PLUGIN_RULES.some((rule) => rule.repo.toLowerCase() === mappedRepo)
        ));
    }

    public applySpecialPluginTags(plugin: ManagerPlugin) {
        if (this.isEondrPlugin(plugin.id) && !plugin.tags.includes(EONDR_PLUGIN_TAG_ID)) {
            plugin.tags.push(EONDR_PLUGIN_TAG_ID);
        }
    }

    private normalizeBuiltinTagNames(): boolean {
        let changed = false;
        const normalize = (id: string, name: string, legacyNames: string[], color: string) => {
            const tag = this.settings.TAGS.find((item) => item.id === id);
            if (!tag) return;
            if (!tag.name || legacyNames.includes(tag.name)) {
                tag.name = name;
                changed = true;
            }
            if (!tag.color) {
                tag.color = color;
                changed = true;
            }
        };

        normalize(BPM_TAG_ID, this.translator.t("标签_BPM安装_名称") || "BPM 安装", [
            "bpm install",
            "bpm安装",
            "BPM Install",
            "BPM Installed",
        ], "#409EFF");
        normalize(BPM_IGNORE_TAG, this.translator.t("标签_BPM忽略_名称") || "BPM 忽略", [
            "BPM Ignore",
            "BPM Ignored",
        ], "#6c757d");
        normalize(EONDR_PLUGIN_TAG_ID, this.translator.t("标签_Eondr插件_名称") || "Eondr 出品", [
            "Eondr Plugin",
            "Eondr Plugins",
            "Eondr",
        ], "#B36BFF");
        return changed;
    }

    // 确保 BPM 自身也存在于插件记录中（用于面板显示）
    public ensureSelfPluginRecord(options: { save?: boolean } = {}): boolean {
        const shouldSave = options.save !== false;
        let changed = false;
        if (!Array.isArray(this.settings.Plugins)) {
            this.settings.Plugins = [];
            changed = true;
        }
        if (!Array.isArray(this.settings.HIDES)) {
            this.settings.HIDES = [];
            changed = true;
        }
        const id = this.manifest.id;
        const existing = this.settings.Plugins.find(p => p.id === id);
        if (this.settings.HIDES?.includes(id)) {
            this.settings.HIDES = this.settings.HIDES.filter(x => x !== id);
            changed = true;
        }
        if (!existing) {
            this.settings.Plugins.push({
                id,
                name: this.manifest.name,
                desc: this.manifest.description,
                group: "",
                tags: [],
                enabled: true,
                delay: "",
                note: "",
            });
            if (shouldSave) void this.saveSettings();
            return true;
        }
        if (!existing.name) {
            existing.name = this.manifest.name;
            changed = true;
        }
        if (!existing.desc) {
            existing.desc = this.manifest.description;
            changed = true;
        }
        if (existing.enabled !== true) {
            existing.enabled = true;
            changed = true;
        }
        if (existing.delay !== "") {
            existing.delay = "";
            changed = true;
        }
        if (changed && shouldSave) void this.saveSettings();
        return changed;
    }

    private reloadIfCurrentModal() {
        try { void this.managerModal?.reloadShowData(); } catch { /* ignore */ }
        try {
            // 直接刷新 UI，不需要重新从文件加载，因为内存状态这一刻是最新的
            this.ribbonModal?.display();
        } catch { /* ignore */ }
    }

    /**
     * 清理 Obsidian Ribbon 内部 items 数组中的 undefined/null 项
     * 防止原生方法遍历时 crash
     * 同时清理重复的 ID，修复切换语言时核心插件图标重复的问题
     * @returns 是否发生了清理（调用方据此决定是否让 Obsidian 重绘）
     */
    public cleanRibbonItems(): boolean {
        const ribbon = this.getLeftRibbon();
        if (!ribbon || !ribbon.items || !Array.isArray(ribbon.items)) return false;

        let cleaned = false;
        const seenIds = new Set<string>();

        // 倒序遍历删除
        for (let i = ribbon.items.length - 1; i >= 0; i--) {
            const item = ribbon.items[i];

            // 删除 null/undefined 项
            if (!item) {
                ribbon.items.splice(i, 1);
                cleaned = true;
                continue;
            }

            // 删除重复 ID 项（保留第一次出现的）
            if (item.id && seenIds.has(item.id)) {
                if (this.settings.DEBUG) {
                    console.warn(`[BPM] Duplicate ribbon item removed from memory: ${item.id}`);
                }
                ribbon.items.splice(i, 1);
                cleaned = true;
                continue;
            }

            if (item.id) {
                seenIds.add(item.id);
            }
        }

        if (cleaned && this.settings.DEBUG) console.log("[BPM] Cleaned undefined/duplicate items from leftRibbon.");
        return cleaned;
    }

    // 关闭延时 调用
    public disableDelay(options: { save?: boolean } = {}): boolean {
        const plugins = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
        return this.synchronizePlugins(plugins, options);
    }

    // 开启延时 调用
    private isBpmIgnoredPlugin(pluginId: string): boolean {
        return Boolean(this.settings.Plugins.find(plugin => plugin.id === pluginId)?.tags.includes(BPM_IGNORE_TAG));
    }

    private getDelayManagedPluginManifests(): PluginManifest[] {
        return Object.values(this.appPlugins.manifests)
            .filter((pm: PluginManifest) => pm.id !== this.manifest.id && !this.isBpmIgnoredPlugin(pm.id));
    }

    public enableDelay(options: { save?: boolean } = {}): boolean {
        const plugins = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
        // 同步插件
        const changed = this.synchronizePlugins(plugins, options);
        // 开始延时启动插件
        this.getDelayManagedPluginManifests().forEach((plugin: PluginManifest) => this.startPluginWithDelay(plugin.id));
        return changed;
    }

    // 为所有插件启动延迟
    public async enableDelaysForAllPlugins() {
        // 获取所有插件
        const plugins = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
        // 同步插件
        this.synchronizePlugins(plugins);

        for (const plugin of this.getDelayManagedPluginManifests()) {
            // 插件状态
            const isEnabled = this.appPlugins.enabledPlugins.has(plugin.id);
            if (isEnabled) {
                // 1. 关闭插件
                await this.appPlugins.disablePluginAndSave(plugin.id);
                // 2. 开启插件
                await this.appPlugins.enablePlugin(plugin.id);
                // 3. 切换配置状态
                const mp = this.settings.Plugins.find(p => p.id === plugin.id);
                if (mp) mp.enabled = true;
                // 4. 保存状态
                await this.saveSettings();
            } else {
                // 1. 切换配置文件
                const mp = this.settings.Plugins.find(p => p.id === plugin.id);
                if (mp) mp.enabled = false;
                // 2. 保存状态
                await this.saveSettings();
            }
        }

        // 批量启停后可能出现新图标，登记一次（显隐与顺序由原生状态自行维持）
        if (this.isRibbonManagerEnabled()) this.applyRibbonSettings();
    }

    /**
     * 关闭延时启动：把被延迟的插件交回 Obsidian 本体托管
     * （disable 再 enableAndSave，使它们进入 community-plugins.json 并由 Obsidian 负责启动）
     *
     * 这是延时开关「关闭」时的专用交接路径，**只允许由设置里的延时开关调用**。
     * 绝不可在 onunload 中调用：卸载分不清「退出 App / 重载插件 / 用户停用 BPM」，
     * 会把用户配置改写掉并让延时启动失效（历史缺陷，详见 onunload 注释）。
     *
     * 与之对称的是 enableDelaysForAllPlugins（开关「开启」时把插件移出该文件并改用运行时延迟启动），
     * 二者共同维持不变量：community-plugins.json 的内容 ↔ 延时开关状态。
     */
    public async disableDelaysForAllPlugins() {
        const plugins = this.getDelayManagedPluginManifests();
        for (const pm of plugins) {
            const plugin = this.settings.Plugins.find(p => p.id === pm.id)
            if (plugin) {
                if (plugin.enabled) {
                    await this.appPlugins.disablePlugin(pm.id);
                    await this.appPlugins.enablePluginAndSave(pm.id);
                }
            }
        }

        if (this.isRibbonManagerEnabled()) this.applyRibbonSettings();
    }

    // 延时启动指定插件
    private startPluginWithDelay(id: string) {
        if (id === this.manifest.id) return;
        if (this.isBpmIgnoredPlugin(id)) return;
        const plugin = this.settings.Plugins.find(p => p.id === id);
        if (plugin && plugin.enabled) {
            const delay = this.settings.DELAYS.find(item => item.id === plugin.delay);
            const time = delay ? delay.time : 0;
            window.setTimeout(() => {
                if (this.isUnloaded) return;
                // 必须 await：插件的 onload 里才注册 ribbon 图标，
                // 不等待就应用等于「条目还没出生就复述设置」，新条目会以 visible 状态留在侧边栏
                void this.appPlugins.enablePlugin(id).then(() => {
                    if (this.isUnloaded) return;
                    if (this.isRibbonManagerEnabled()) this.applyRibbonSettings();
                });
            }, time * 1000);
        }
    }

    // 同步插件到配置文件
    public synchronizePlugins(p1: PluginManifest[], options: { save?: boolean } = {}): boolean {
        const previousStateJson = JSON.stringify({
            Plugins: this.settings.Plugins,
            HIDES: this.settings.HIDES,
        });
        const shouldSave = options.save !== false;
        const manifestIds = new Set(p1.map((plugin) => plugin.id));
        const bpmInstalledIds = new Set(this.settings.BPM_INSTALLED || []);
        const nextPlugins = this.settings.Plugins.filter((plugin) => {
            return plugin.id === this.manifest.id || manifestIds.has(plugin.id);
        });
        const pluginSettingsById = new Map(nextPlugins.map((plugin) => [plugin.id, plugin]));

        p1.forEach(p1Item => {
            let mp = pluginSettingsById.get(p1Item.id);
            if (!mp) {
                const isEnabled = this.appPlugins.enabledPlugins.has(p1Item.id);
                mp = {
                    'id': p1Item.id,
                    'name': p1Item.name,
                    'desc': p1Item.description,
                    'group': '',
                    'tags': [],
                    'enabled': isEnabled,
                    'delay': '',
                    'note': ''
                };
                nextPlugins.push(mp);
                pluginSettingsById.set(p1Item.id, mp);
            }
            if (bpmInstalledIds.has(p1Item.id) && !mp.tags.includes(BPM_TAG_ID)) {
                mp.tags.push(BPM_TAG_ID);
            }
            this.applySpecialPluginTags(mp);
        });
        this.settings.Plugins = nextPlugins;
        // BPM 自身保持启用且不允许延迟
        this.ensureSelfPluginRecord({ save: false });
        const nextStateJson = JSON.stringify({
            Plugins: this.settings.Plugins,
            HIDES: this.settings.HIDES,
        });
        const changed = previousStateJson !== nextStateJson;
        if (changed && shouldSave) void this.saveSettings();
        return changed;
    }

    // 工具函数
    public createTag(text: string, color: string, type: string) {
        const style = this.generateTagStyle(color, type);
        const tag = createEl('span', {
            text: text,
            cls: 'manager-tag',
            attr: { 'style': style }
        })
        return tag;
    }
    public generateTagStyle(color: string, type: string) {
        let style;
        const [r, g, b] = this.hexToRgbArray(color);
        switch (type) {
            case 'a':
                style = `color: #fff; background-color: ${color}; border-color: ${color};`;
                break;
            case 'b':
                style = `color: ${color}; background-color: transparent; border-color: ${color};`;
                break;
            case 'c':
                style = `color: ${color}; background-color: rgba(${r}, ${g}, ${b}, 0.3); border-color: ${color};`;
                break;
            case 'd':
                style = `color: ${color}; background-color: ${this.adjustColorBrightness(color, 50)}; border-color: ${this.adjustColorBrightness(color, 50)};`;
                break;
            default:
                style = `background-color: transparent;border-style: dashed;`;
        }
        return style;
    }
    public hexToRgbArray(hex: string) {
        const rgb = parseInt(hex.slice(1), 16);
        const r = (rgb >> 16);
        const g = ((rgb >> 8) & 0x00FF);
        const b = (rgb & 0x0000FF);
        return [r, g, b];
    }
    public adjustColorBrightness(hex: string, amount: number) {
        const rgb = parseInt(hex.slice(1), 16);
        const r = Math.min(255, Math.max(0, ((rgb >> 16) & 0xFF) + amount));
        const g = Math.min(255, Math.max(0, ((rgb >> 8) & 0xFF) + amount));
        const b = Math.min(255, Math.max(0, (rgb & 0xFF) + amount));
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
    }

    // 获取 Obsidian 当前语言（兼容旧版类型定义）
    public getAppLanguage(): string {
        // 优先使用 app.i18n.locale / language
        const appWithInternals = this.app as ObsidianAppWithInternals;
        const langCandidates: (string | undefined)[] = [
            appWithInternals.i18n?.locale,
            appWithInternals.i18n?.lang,
            appWithInternals.i18n?.language,
            (window as WindowWithMoment).moment?.locale?.(),
            navigator.language,
        ];
        const picked = langCandidates.find((l) => typeof l === "string" && l.length > 0) || "en";
        const lower = picked.toLowerCase().replace('_', '-');
        const map: Record<string, string> = {
            'en': 'en',
            'en-gb': 'en',
            'zh': 'zh-cn',
            'zh-cn': 'zh-cn',
            'zh-tw': 'zh-cn',
            'ru': 'ru',
            'ja': 'ja',
            'ko': 'ko',
            'fr': 'fr',
            'es': 'es',
        };
        return map[lower] || map[lower.split('-')[0]] || 'en';
    }

    // 版本比较：>0 表示 a>b
    private compareVersions(a = "0.0.0", b = "0.0.0"): number {
        const normalize = (value: string) => value
            .trim()
            .replace(/^v(?=\d)/i, "")
            .split(/[.+-]/)
            .map((part) => {
                const parsed = Number.parseInt(part, 10);
                return Number.isFinite(parsed) ? parsed : 0;
            });
        const pa = normalize(a);
        const pb = normalize(b);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const ai = pa[i] || 0;
            const bi = pb[i] || 0;
            if (ai > bi) return 1;
            if (ai < bi) return -1;
        }
        return 0;
    }

    private normalizePluginUpdateCheckMode(value?: string | null): PluginUpdateCheckMode {
        return value === "version" ? "version" : "release";
    }

    private normalizeReleaseCompatibilityMode(value?: string | null): ReleaseCompatibilityMode {
        return value === "all" ? "all" : "compatible";
    }

    private normalizePluginUpdateDelayDays(value: unknown): number {
        const days = Math.floor(Number(value));
        return Number.isFinite(days) && days > 0 ? days : 0;
    }

    private resolvePluginUpdateCheckOptions(options?: PluginUpdateCheckOptions): Required<PluginUpdateCheckOptions> {
        return {
            updateCheckMode: this.normalizePluginUpdateCheckMode(options?.updateCheckMode ?? this.settings.PLUGIN_UPDATE_CHECK_MODE),
            compatibilityMode: this.normalizeReleaseCompatibilityMode(options?.compatibilityMode ?? this.settings.PLUGIN_UPDATE_COMPATIBILITY_MODE),
            updateDelayDays: this.normalizePluginUpdateDelayDays(options?.updateDelayDays ?? this.settings.PLUGIN_UPDATE_DELAY_DAYS),
        };
    }

    private applyPluginUpdateStatus(
        st: UpdateStatus,
        pm: PluginManifest,
        repo: string | null,
        versions: ReleaseVersion[],
        fallbackRemoteVersion: string | null | undefined,
        options: Required<PluginUpdateCheckOptions>
    ) {
        const localVersion = pm.version || "0.0.0";
        const remoteFallback = fallbackRemoteVersion || null;
        st.localVersion = localVersion;
        st.repo = repo;
        st.versions = versions;
        st.checkMode = options.updateCheckMode;
        st.updateDelayDays = options.updateDelayDays;

        if (versions.length > 0 && repo) {
            const source: BetaSource = {
                id: pm.id,
                repo,
                type: "plugin",
                mode: "latest",
                includePrerelease: false,
                updateCheckMode: options.updateCheckMode,
                compatibilityMode: options.compatibilityMode,
                updateDelayDays: options.updateDelayDays || undefined,
                autoUpdate: false,
                enabled: true,
                localVersion,
                latestVersion: remoteFallback || undefined,
                latestReleaseTag: remoteFallback || undefined,
            };
            const releaseCheck = syncSourceReleaseCheck(source, versions, localVersion);
            st.remoteVersion = releaseCheck.target?.tag || null;
            st.remotePublishedAt = releaseCheck.target?.publishedAt;
            st.hasUpdate = sourceHasConfiguredUpdate(source);
            return;
        }

        st.remoteVersion = remoteFallback;
        st.hasUpdate = remoteFallback ? this.compareVersions(remoteFallback, localVersion) > 0 : false;
        if (!st.remoteVersion) st.message = this.translator.t("更新_未获取到远端版本");
    }

    // 检测插件更新：官方 + GitHub（BPM 或用户指定仓库）
    public async checkUpdates(opts?: PluginUpdateCheckRunOptions): Promise<Record<string, UpdateStatus>> {
        const manifests = Object.values(this.appPlugins.manifests).filter((pm: PluginManifest) => pm.id !== this.manifest.id);
        const officialMap = await this.fetchOfficialStats();
        const statusMap: Record<string, UpdateStatus> = {};
        const updateOptions = this.resolvePluginUpdateCheckOptions(opts);
        this.updateStatus = statusMap;

        if (this.settings.DEBUG) console.log("[BPM] checkUpdates start, total manifests:", manifests.length);
        for (const pm of manifests) {
            if (opts?.isCancelled?.()) break;
            const localVersion = pm.version || "0.0.0";
            const st: UpdateStatus = { source: 'unknown', localVersion, checkedAt: Date.now() };
            try {
                // 1) 官方来源
                const official = officialMap[pm.id];
                if (official) {
                    st.source = 'official';
                    try {
                        st.repo = await this.repoResolver.resolveRepo(pm.id);
                    } catch {
                        st.repo = null;
                    }
                    if (st.repo) {
                        st.versions = await this.fetchGithubVersions(st.repo, updateOptions.updateCheckMode === "release", true);
                    }
                    this.applyPluginUpdateStatus(st, pm, st.repo || null, st.versions || [], official, updateOptions);
                    if (this.settings.DEBUG) console.log("[BPM] update official match", pm.id, localVersion, "->", st.remoteVersion);
                } else {
                    // 2) GitHub：BPM 安装或有仓库映射 / 用户填写
                    let repo: string | null = this.settings.REPO_MAP[pm.id] || null;
                    if (!repo) {
                        try {
                            repo = await this.repoResolver.resolveRepo(pm.id);
                        } catch {
                            // ignore
                        }
                    }
                    if (repo) {
                        st.source = 'github';
                        st.repo = repo;
                        st.versions = await this.fetchGithubVersions(repo, updateOptions.updateCheckMode === "release", true);
                        const remoteVersion = st.versions.length > 0 ? null : await this.fetchGithubManifestVersion(repo);
                        this.applyPluginUpdateStatus(st, pm, repo, st.versions || [], remoteVersion, updateOptions);
                        if (!st.remoteVersion) st.message = this.translator.t("更新_未获取到远端版本");
                        if (this.settings.DEBUG) console.log("[BPM] update github match", pm.id, repo, localVersion, "->", st.remoteVersion);
                    } else {
                        st.source = 'unknown';
                        st.message = this.translator.t("更新_无来源无法检测");
                        if (this.settings.DEBUG) console.log("[BPM] update unknown source", pm.id);
                    }
                }
            } catch (e) {
                st.error = (e as Error)?.message || String(e);
                console.error("[BPM] checkUpdates error", pm.id, e);
            }
            statusMap[pm.id] = st;
            opts?.onProgress?.(pm.id);
        }
        this.updateStatus = statusMap;
        return statusMap;
    }

    public async checkUpdateForPlugin(pluginId: string, options?: PluginUpdateCheckOptions): Promise<UpdateStatus | null> {
        const pm = this.appPlugins.manifests[pluginId] as PluginManifest | undefined;
        if (!pm) return null;
        const localVersion = pm.version || "0.0.0";
        const st: UpdateStatus = { source: "unknown", localVersion, checkedAt: Date.now() };
        const updateOptions = this.resolvePluginUpdateCheckOptions(options);
        try {
            const officialMap = await this.fetchOfficialStats();
            const official = officialMap[pm.id];
            if (official) {
                st.source = "official";
                try {
                    st.repo = await this.repoResolver.resolveRepo(pm.id);
                    if (st.repo) st.versions = await this.fetchGithubVersions(st.repo, updateOptions.updateCheckMode === "release", true);
                } catch {
                    if (updateOptions.updateCheckMode === "release") throw new Error(this.translator.t("更新_未获取到远端版本"));
                }
                this.applyPluginUpdateStatus(st, pm, st.repo || null, st.versions || [], official, updateOptions);
                this.updateStatus[pm.id] = st;
                if (this.settings.DEBUG) console.log("[BPM] single update official", pm.id, localVersion, "->", st.remoteVersion);
                return st;
            }

            let repo: string | null = this.settings.REPO_MAP[pm.id] || null;
            if (!repo) {
                try { repo = await this.repoResolver.resolveRepo(pm.id); } catch { repo = null; }
            }
            if (repo) {
                st.source = "github";
                st.repo = repo;
                st.versions = await this.fetchGithubVersions(repo, updateOptions.updateCheckMode === "release", true);
                const remoteVersion = st.versions.length > 0 ? null : await this.fetchGithubManifestVersion(repo);
                this.applyPluginUpdateStatus(st, pm, repo, st.versions || [], remoteVersion, updateOptions);
                if (!st.remoteVersion) st.message = this.translator.t("更新_未获取到远端版本");
                if (this.settings.DEBUG) console.log("[BPM] single update github", pm.id, repo, localVersion, "->", st.remoteVersion);
            } else {
                st.source = "unknown";
                st.message = this.translator.t("更新_无来源无法检测");
                if (this.settings.DEBUG) console.log("[BPM] single update unknown source", pm.id);
            }
        } catch (e) {
            st.error = (e as Error)?.message || String(e);
            console.error("[BPM] checkUpdateForPlugin error", pm.id, e);
        }
        this.updateStatus[pm.id] = st;
        return st;
    }

    private async fetchOfficialStats(): Promise<Record<string, string>> {
        const url = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";
        try {
            const res = await requestUrl({ url: resolveGithubUrl(this, url) });
            const json = res.json as Record<string, CommunityPluginStatsEntry>;
            const map: Record<string, string> = {};
            Object.entries(json || {}).forEach(([id, entry]) => {
                if (entry && typeof entry === "object") {
                    const latest = this.getLatestVersionFromStats(entry);
                    if (latest) map[id] = latest;
                }
            });
            return map;
        } catch (e) {
            console.error("获取官方插件 stats 失败", e);
            return {};
        }
    }

    private getLatestVersionFromStats(entry: CommunityPluginStatsEntry): string | null {
        const versions = Object.keys(entry || {}).filter(k => k !== "downloads" && k !== "updated");
        if (versions.length === 0) return null;
        let latest = versions[0];
        for (const v of versions) {
            if (this.compareVersions(v, latest) > 0) latest = v;
        }
        return latest;
    }

    private async fetchGithubManifestVersion(repo: string): Promise<string | null> {
        const token = await this.getGithubToken();
        const headers: Record<string, string> = {
            "User-Agent": "better-plugins-manager"
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        // 1) 尝试最新 release 的 manifest.json
        try {
            const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            const release = await requestUrl({ url: resolveGithubUrl(this, releaseUrl), headers });
            const assets = (release.json?.assets || []) as { name: string; browser_download_url: string }[];
            const manifestAsset = assets.find(a => a.name === "manifest.json");
            if (manifestAsset?.browser_download_url) {
                const manifestRes = await requestUrl({ url: resolveGithubUrl(this, manifestAsset.browser_download_url), headers });
                const manifest = manifestRes.json as { version?: string };
                if (manifest?.version) return manifest.version;
            }
        } catch {
            // ignore and fallback
        }

        // 2) 尝试默认分支 (HEAD) raw manifest
        const candidates = [
            `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`,
            `https://raw.githubusercontent.com/${repo}/main/manifest.json`,
            `https://raw.githubusercontent.com/${repo}/master/manifest.json`,
        ];
        for (const url of candidates) {
            try {
                const res = await requestUrl({ url: resolveGithubUrl(this, url), headers });
                const manifest = res.json as { version?: string };
                if (manifest?.version) return manifest.version;
            } catch {
                // try next
            }
        }
        return null;
    }

    private async fetchGithubVersions(repoInput: string, throwOnError = false, includeManifest = false): Promise<ReleaseVersion[]> {
        try {
            return await fetchReleaseVersions(this, repoInput, { includeManifest });
        } catch (e) {
            console.error("[BPM] fetchGithubVersions error", repoInput, e);
            if (throwOnError) throw e;
            return [];
        }
    }

    public async downloadUpdate(pluginId: string, version?: string): Promise<boolean> {
        const st = this.updateStatus[pluginId];
        let repo = st?.repo || this.settings.REPO_MAP[pluginId] || null;
        if (!repo) {
            try {
                repo = await this.repoResolver.resolveRepo(pluginId);
            } catch { repo = null; }
        }
        if (!repo) {
            new Notice(this.translator.t("下载更新_缺少仓库提示"));
            return false;
        }
        const ok = await installPluginFromGithub(this, repo, version, false);
        if (ok) {
            await this.checkUpdates();
            try {
                this.managerModal?.refreshPluginCard(pluginId, { allowReload: true });
            } catch {
                this.reloadIfCurrentModal();
            }
        }
        return ok;
    }

    /**
     * 生成自动配色，使用“黄金角”分布避免颜色过于接近。
     * existingColors: 已存在的颜色列表，用于避免重复/过近。
     */
    public generateAutoColor(existingColors: string[] = []): string {
        const baseHue = (existingColors.length * 137.508) % 360;
        let hue = baseHue;
        const saturation = 68;
        const lightness = 60;

        const isClose = (hex: string) => {
            const [r, g, b] = this.hexToRgbArray(hex);
            for (const c of existingColors) {
                const [cr, cg, cb] = this.hexToRgbArray(c);
                const dist = Math.sqrt(
                    Math.pow(r - cr, 2) + Math.pow(g - cg, 2) + Math.pow(b - cb, 2)
                );
                if (dist < 60) return true; // 阈值越小，颜色越分散
            }
            return false;
        };

        for (let i = 0; i < Math.max(existingColors.length + 6, 12); i++) {
            const hex = this.hslToHex(hue, saturation, lightness);
            if (!isClose(hex)) return hex;
            hue = (hue + 27) % 360; // 继续偏移尝试
        }
        // 兜底
        return '#A079FF';
    }

    private hslToHex(h: number, s: number, l: number): string {
        s /= 100;
        l /= 100;
        const k = (n: number) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        const r = Math.round(255 * f(0));
        const g = Math.round(255 * f(8));
        const b = Math.round(255 * f(4));
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
    }

}
