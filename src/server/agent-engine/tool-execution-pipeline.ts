export interface ToolExecutionRequest<TIntent, TContext> {
  intent: TIntent;
  context?: TContext;
}

export type ToolPreExecute<TIntent, TContext, TResult> = (
  request: ToolExecutionRequest<TIntent, TContext>,
) => Promise<TResult | undefined> | TResult | undefined;

export type ToolExecuteMiddleware<TIntent, TContext, TResult> = (
  request: ToolExecutionRequest<TIntent, TContext>,
  next: () => Promise<TResult>,
) => Promise<TResult>;

export type ToolPostExecute<TIntent, TContext, TResult> = (
  request: ToolExecutionRequest<TIntent, TContext>,
  result: TResult,
) => Promise<TResult> | TResult;

/**
 * Stable tool lifecycle seam. Mandatory host policy belongs in preExecute,
 * execution concerns such as serialization/timeout wrap execute, and durable
 * evidence belongs in postExecute. A preExecute result short-circuits the
 * terminal executor but still passes through postExecute for audit parity.
 */
export class ToolExecutionPipeline<TIntent, TContext, TResult> {
  constructor(
    private readonly preExecute: readonly ToolPreExecute<TIntent, TContext, TResult>[] = [],
    private readonly executeMiddleware: readonly ToolExecuteMiddleware<TIntent, TContext, TResult>[] = [],
    private readonly postExecute: readonly ToolPostExecute<TIntent, TContext, TResult>[] = [],
  ) {}

  async run(
    request: ToolExecutionRequest<TIntent, TContext>,
    terminal: (request: ToolExecutionRequest<TIntent, TContext>) => Promise<TResult>,
  ): Promise<TResult> {
    let result: TResult | undefined;
    let shortCircuited = false;
    for (const middleware of this.preExecute) {
      const candidate = await middleware(request);
      if (candidate !== undefined) {
        result = candidate;
        shortCircuited = true;
        break;
      }
    }
    if (!shortCircuited) result = await this.dispatch(0, request, terminal);
    for (const middleware of this.postExecute) result = await middleware(request, result as TResult);
    return result as TResult;
  }

  private dispatch(
    index: number,
    request: ToolExecutionRequest<TIntent, TContext>,
    terminal: (request: ToolExecutionRequest<TIntent, TContext>) => Promise<TResult>,
  ): Promise<TResult> {
    const middleware = this.executeMiddleware[index];
    if (!middleware) return terminal(request);
    let delegated = false;
    return middleware(request, () => {
      if (delegated) return Promise.reject(new Error(`tool execute middleware ${index} called next() more than once`));
      delegated = true;
      return this.dispatch(index + 1, request, terminal);
    });
  }
}
