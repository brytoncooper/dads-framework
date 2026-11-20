/** A protocol handler receiving a Fetch request and returning its complete answer. */
export type FetchHandler = {
  readonly handler: (request: Request) => Promise<Response>;
};
