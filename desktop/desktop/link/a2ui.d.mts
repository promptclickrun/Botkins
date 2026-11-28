export const A2UI_VERSION: "1.0";
export const A2UI_BASIC_CATALOG_ID: string;
export const A2UI_BOTKINS_CATALOG_ID: string;
export const A2UI_SUPPORTED_CATALOG_IDS: readonly string[];

export const A2UI_LIMITS: {
  maxMessagesPerCall: number;
  maxSurfacesPerMessage: number;
  maxSurfacesPerTurn: number;
  maxComponents: number;
  maxComponentIdLength: number;
  maxSurfaceIdLength: number;
  maxPayloadBytes: number;
  maxDataModelBytes: number;
  maxDataModelDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxActionContextBytes: number;
  maxActedRecords: number;
  maxFunctionCallsPerSurface: number;
  maxInlineCatalogs: number;
  maxInlineCatalogBytes: number;
  defaultFunctionTimeoutMs: number;
  maxFunctionTimeoutMs: number;
};

export const A2UI_BASIC_COMPONENTS: Set<string>;
export const A2UI_BOTKINS_COMPONENTS: Set<string>;
export const A2UI_BASIC_ICONS: Set<string>;
export const A2UI_BASIC_FUNCTIONS: Set<string>;
export const A2UI_BOTKINS_FUNCTIONS: Set<string>;
export const A2UI_BASIC_FUNCTION_DEFS: Record<string, { returnType: string; allowedCallers: string; requiresUserActivation: boolean; sideEffecting?: boolean }>;
export const A2UI_BOTKINS_FUNCTION_DEFS: Record<string, { returnType: string; allowedCallers: string; requiresUserActivation: boolean; sideEffecting?: boolean }>;

export interface A2uiSurfaceState {
  surfaceId: string;
  version: "1.0";
  catalogId?: string;
  sendDataModel?: boolean;
  components: Array<Record<string, any>>;
  dataModel: Record<string, any>;
  inlineCatalogs?: Array<Record<string, any>>;
  allowMembers?: boolean;
  metadata?: Record<string, any>;
  ownerBotId?: string;
  workflow?: { workflowId: string; workflowName?: string; runId?: string; onAction?: "bot" | "resume" | "trigger"; targetWorkflowId?: string };
  dispatch?: { prompt?: string; botId?: string; botName?: string; label?: string; chatTitle?: string };
  state?: "open" | "dispatched" | "dismissed";
  dispatchedChatId?: string;
  dispatchedBotId?: string;
  dispatchedBotName?: string;
  acted?: Record<string, any>;
  pendingRendererCalls?: Array<{ surfaceId?: string; functionCallId: string; callFunction: Record<string, any>; createdAt?: number }>;
  functionResults?: Record<string, { functionCallId: string; value?: any; error?: { code: string; message: string }; status?: string; updatedAt?: number }>;
  deleted?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export function getA2uiRendererCapabilities(extraCatalogIds?: string[], inlineCatalogs?: Array<Record<string, any>>): {
  "1.0": { supportedCatalogIds: string[]; inlineCatalogs?: Array<Record<string, any>> };
};

export function isSafeA2uiUrl(raw: unknown, opts?: { allowDataImage?: boolean }): boolean;
export function isSafeA2uiMediaUrl(raw: unknown): boolean;
export function sanitizeJsonValue(value: unknown, depth?: number): any;
export function validateCatalogDefinition(raw: unknown): Record<string, any>;
export function buildCatalogRegistry(extraCatalogs?: Array<Record<string, any>>): Map<string, any>;
export function lookupCatalogFunction(
  functionName: string,
  catalogId?: string,
  opts?: { surfaceCatalogId?: string; inlineCatalogs?: Array<Record<string, any>>; extraCatalogs?: Array<Record<string, any>> },
): { catalogId: string; name: string; def: { returnType: string; allowedCallers: string; requiresUserActivation: boolean; sideEffecting?: boolean } } | null;
export function validateFunctionReturnValue(value: unknown, fnDef: any): { valid: boolean; message?: string };
export function validateA2uiComponent(raw: unknown, index: number, options?: Record<string, any>): Record<string, any>;
export function validateA2uiMessage(raw: unknown, options?: Record<string, any>): Record<string, any>;
export function validateA2uiMessages(messages: unknown, options?: Record<string, any>): Array<Record<string, any>>;
export function buildRendererActionEnvelope(args: {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp?: string;
  context?: Record<string, any>;
  userMessage?: string;
  metadata?: Record<string, any>;
}): { version: "1.0"; action: Record<string, any> };
export function buildCallAgentFunctionEnvelope(args: {
  surfaceId: string;
  functionCallId: string;
  callFunction: Record<string, any>;
}): { version: "1.0"; callAgentFunction: Record<string, any> };
export function buildRendererFunctionResponseEnvelope(args: {
  functionCallId: string;
  value?: any;
  error?: { code: string; message: string };
}): { version: "1.0"; rendererFunctionResponse: Record<string, any> };
export function validateRendererToAgentMessage(raw: unknown): Record<string, any>;
export function decodePointerToken(token: string): string;
export function splitPointer(path: string): string[];
export function getDataAtPointer(dataModel: unknown, pointer: string, scopePath?: string): any;
export function setDataAtPointer(dataModel: unknown, path: string, value: unknown): Record<string, any>;
export function resolveDynamicValue(value: unknown, dataModel: unknown, ctx?: Record<string, any>, depth?: number): any;
export function resolveDynamicString(value: unknown, dataModel: unknown, ctx?: Record<string, any>): string;
export function resolveDynamicNumber(value: unknown, dataModel: unknown, ctx?: Record<string, any>): number;
export function resolveDynamicBoolean(value: unknown, dataModel: unknown, ctx?: Record<string, any>): boolean;
export function resolveDynamicStringList(value: unknown, dataModel: unknown, ctx?: Record<string, any>): string[];
export function executeRendererFunctionCall(
  callMessage: unknown,
  opts?: {
    dataModel?: Record<string, any>;
    surfaceCatalogId?: string;
    inlineCatalogs?: Array<Record<string, any>>;
    themeMode?: "light" | "dark";
    userActivated?: boolean;
    handlers?: {
      confirmSideEffect?: (info: { name: string; catalogId: string; args: Record<string, any> }) => boolean | Promise<boolean>;
      openUrl?: (url: string) => void | Promise<void>;
      copyToClipboard?: (text: string) => boolean | Promise<boolean>;
      custom?: (info: { name: string; catalogId: string; args: Record<string, any> }) => any | Promise<any>;
    };
  },
): Promise<{ version: "1.0"; rendererFunctionResponse: Record<string, any> }>;
export function evaluateChecks(component: any, dataModel: unknown, ctx?: Record<string, any>): string[];
export function resolveActionEvent(action: any, dataModel: unknown, ctx?: Record<string, any>): {
  name: string;
  userMessage?: string;
  context: Record<string, any>;
} | null;
export function validateSurfaceTree(surface: A2uiSurfaceState, registry?: Map<string, any>): { valid: boolean; errors: string[] };
export function applyA2uiMessages(
  existingSurfaces: A2uiSurfaceState[] | undefined,
  rawMessages: unknown,
  meta?: Record<string, any>,
  options?: Record<string, any>,
): {
  surfaces: Map<string, A2uiSurfaceState>;
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  touchedIds: string[];
  rendererFunctionCalls: Array<Record<string, any>>;
  agentFunctionResponses: Array<Record<string, any>>;
};
export function hasUnsupportedA2uiComponent(surface: A2uiSurfaceState | null | undefined): boolean;
export function summarizeA2uiSurface(surface: A2uiSurfaceState | null | undefined): {
  lines: string[];
  actions: Array<{
    componentId: string;
    label: string;
    variant: string;
    action: any;
    scopePath: string;
    itemIndex?: number;
  }>;
  text: string;
};
export function validateA2uiActionPayload(payload: unknown): {
  version: "1.0";
  surfaceId: string;
  sourceComponentId: string;
  name: string;
  actionId: string;
  userMessage?: string;
  timestamp: string;
  context: Record<string, any>;
  dataModel?: Record<string, any>;
  isBuiltin: boolean;
};
export function validateA2uiFunctionRpcPayload(payload: unknown): any;
