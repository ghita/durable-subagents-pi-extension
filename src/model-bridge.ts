import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
	AnyModel,
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthCheck,
	AuthInteraction,
	AuthResult,
	AuthType,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Credential,
	DeferredFetchOptions,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	LoginOptions,
	Model,
	Models,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
} from "@earendil-works/pi-ai";

/**
 * The public Pi extension context exposes a ModelRegistry, not pi-ai's complete
 * Models implementation. This adapter forwards actual model requests to that
 * registry, so request-time provider authentication remains owned by Pi.
 * It never reads or copies credential files.
 */
export function createPiModelBridge(registry: ModelRegistry): Models {
	const unsupported = (operation: string): Error =>
		new Error(`Pi's public ModelRegistry does not expose ${operation}; this durable model operation is unavailable.`);

	const models: Models = {
		getProviders: () =>
			registry
				.getRegisteredProviderIds()
				.map((id) => registry.getProvider(id))
				.filter((provider): provider is Provider => provider !== undefined),
		getProvider: (id) => registry.getProvider(id),
		getModels: (provider) =>
			registry.getAll().filter((model) => provider === undefined || model.provider === provider),
		getModel: (provider, id) => registry.find(provider, id),
		getModelsOfType: <TType extends ModelType>(type: TType, provider?: string) =>
			registry.getModelsOfType(type, provider),
		getModelOfType: <TType extends ModelType>(type: TType, provider: string, id: string) =>
			registry.getModelOfType(type, provider, id),
		getAllModels: (provider) => [
			...registry.getAll().filter((model) => provider === undefined || model.provider === provider),
			...registry.getModelsOfType("image", provider),
			...registry.getModelsOfType("classifier", provider),
		],
		refresh: (options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> => registry.refresh(options),
		checkAuth: async (providerId: string): Promise<AuthCheck | undefined> => {
			const status = registry.getProviderAuthStatus(providerId);
			if (!status.configured) return undefined;
			const provider = registry.getProvider(providerId);
			return {
				type: provider?.auth.oauth === undefined ? "api_key" : "oauth",
				...(status.source === undefined ? {} : { source: status.source }),
			};
		},
		getAvailable: async (provider) =>
			registry.getAvailable().filter((model) => provider === undefined || model.provider === provider),
		getAvailableOfType: <TType extends ModelType>(type: TType, provider?: string) =>
			registry.getAvailableOfType(type, provider),
		getAllAvailable: async (provider) => [
			...registry.getAvailable().filter((model) => provider === undefined || model.provider === provider),
			...await registry.getAvailableOfType("image", provider),
			...await registry.getAvailableOfType("classifier", provider),
		],
		getAuth: (modelOrProvider, _options): Promise<AuthResult | undefined> =>
			registry.getProviderAuth(typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider),
		login: async (
			_providerId: string,
			_type: AuthType,
			_interaction: AuthInteraction,
			_options?: LoginOptions,
		): Promise<Credential> => {
			throw unsupported("provider login");
		},
		logout: async (_providerId: string): Promise<void> => {
			throw unsupported("provider logout");
		},
		stream: <TApi extends Api>(
			model: Model<TApi>,
			context: Parameters<ModelRegistry["stream"]>[1],
			options?: ModelsApiStreamOptions<TApi>,
		): AssistantMessageEventStream => registry.stream(model, context, options),
		complete: <TApi extends Api>(
			model: Model<TApi>,
			context: Parameters<ModelRegistry["complete"]>[1],
			options?: ModelsApiStreamOptions<TApi>,
		): Promise<AssistantMessage> => registry.complete(model, context, options),
		streamSimple: (
			model: Model<Api>,
			context: Parameters<ModelRegistry["streamSimple"]>[1],
			options?: ModelsSimpleStreamOptions,
		) => registry.streamSimple(model, context, options),
		completeSimple: (model, context, options?: ModelsSimpleStreamOptions) =>
			registry.streamSimple(model, context, options).result(),
		streamDeferred: (_model, _handle, _options?: ModelsDeferredFetchOptions): AssistantMessageEventStream => {
			throw unsupported("deferred streaming");
		},
		fetchDeferred: async (
			_model: Model<Api>,
			_handle: DeferredHandle,
			_options?: DeferredFetchOptions,
		): Promise<AssistantMessage> => {
			throw unsupported("deferred response fetching");
		},
		cancelDeferred: async (
			_model: Model<Api>,
			_handle: DeferredHandle,
			_options?: ModelsDeferredCancelOptions,
		): Promise<void> => {
			throw unsupported("deferred response cancellation");
		},
		generateImages: (
			model: ImageModel<ImageApi>,
			context: ImagesContext,
			options?: ModelsImagesOptions,
		) => registry.generateImages(model, context, options),
		classify: (
			model: ClassifierModel<ClassifierApi>,
			context: ClassifierContext,
			options?: ModelsClassifierOptions,
		): Promise<ClassifierResult> => registry.classify(model, context, options),
	};

	return models;
}

/** A narrow contract used by tests to prove requests are delegated unchanged. */
export type PiModelRequestRegistry = Pick<ModelRegistry, "find" | "streamSimple">;

/** Convert a Pi model selection to Durable's persisted provider/model reference. */
export function modelReference(model: Model<Api>): { provider: string; modelId: string } {
	return { provider: model.provider, modelId: model.id };
}

/** Type guard useful when a configuration names a model absent from Pi's catalog. */
export function resolvePiModel(registry: ModelRegistry, provider: string, modelId: string): Model<Api> | undefined {
	const model: AnyModel | undefined = registry.find(provider, modelId);
	return model;
}
