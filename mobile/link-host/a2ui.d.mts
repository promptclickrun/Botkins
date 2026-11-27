export declare const A2UI_VERSION: "1.0";
export declare const A2UI_BASIC_CATALOG_ID: string;
export declare const A2UI_LIMITS: Record<string, number>;
export declare const A2UI_BASIC_COMPONENTS: Set<string>;
export declare const A2UI_BASIC_ICONS: Set<string>;
export declare const A2UI_BASIC_FUNCTIONS: Set<string>;

export type A2uiEvalContext = {
  scopePath?: string;
  itemIndex?: number;
};

export type A2uiFallbackAction = {
  componentId: string;
  label: string;
  variant: string;
  action: Record<string, unknown>;
  scopePath: string;
  itemIndex?: number;
};

export type A2uiSurfaceSummary = {
  lines: string[];
  actions: A2uiFallbackAction[];
  text: string;
};

export declare function isSafeA2uiUrl(raw: unknown, options?: { allowDataImage?: boolean }): boolean;
export declare function sanitizeJsonValue(value: unknown, depth?: number): unknown;
export declare function validateA2uiComponent(raw: unknown, index: number, options?: { allowUnknownComponents?: boolean }): Record<string, unknown>;
export declare function validateA2uiMessage(raw: unknown, options?: { allowUnknownComponents?: boolean }): Record<string, unknown>;
export declare function validateA2uiMessages(messages: unknown, options?: { allowUnknownComponents?: boolean }): Record<string, unknown>[];
export declare function getDataAtPointer(dataModel: unknown, pointer: string, scopePath?: string): unknown;
export declare function setDataAtPointer(dataModel: unknown, path: string, value: unknown): Record<string, unknown>;
export declare function resolveDynamicValue(value: unknown, dataModel: unknown, ctx?: A2uiEvalContext, depth?: number): unknown;
export declare function resolveDynamicString(value: unknown, dataModel: unknown, ctx?: A2uiEvalContext): string;
export declare function resolveDynamicNumber(value: unknown, dataModel: unknown, ctx?: A2uiEvalContext): number;
export declare function resolveDynamicBoolean(value: unknown, dataModel: unknown, ctx?: A2uiEvalContext): boolean;
export declare function resolveDynamicStringList(value: unknown, dataModel: unknown, ctx?: A2uiEvalContext): string[];
export declare function evaluateChecks(component: Record<string, unknown>, dataModel: unknown, ctx?: A2uiEvalContext): string[];
export declare function resolveActionEvent(
  action: Record<string, unknown>,
  dataModel: unknown,
  ctx?: A2uiEvalContext,
): { name: string; userMessage?: string; context: Record<string, unknown> } | null;
export declare function validateSurfaceTree(surface: unknown): { valid: boolean; errors: string[] };
export declare function applyA2uiMessages(
  existingSurfaces: unknown[],
  rawMessages: unknown,
  meta?: Record<string, unknown>,
  options?: { allowUnknownComponents?: boolean },
): {
  surfaces: Map<string, Record<string, unknown>>;
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  touchedIds: string[];
};
export declare function summarizeA2uiSurface(surface: unknown): A2uiSurfaceSummary;
export declare function validateA2uiActionPayload(payload: unknown): Record<string, unknown>;
