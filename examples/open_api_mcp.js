import {MCPProxy} from "../mcp-proxy.js";
import Swagger from "swagger-client";

/**
 * Example about how to create an open api mcp that enables the llm to discover the endpoints
 */
export class OpenApiMcp  {
    constructor({openApiUrl,apiDescription, headers}) {
        this.mcpProxy = new MCPProxy({
            discoverDescriptionExtras: apiDescription
        })
        this.headers = headers;
        this.openApiUrl = openApiUrl;
    }

    #parseParams(operation) {
        const parsedParams = {type: 'object', properties: {
            parameters: {type: 'object', properties: {}},
            requestBody: {type: 'object', properties: {}}
        }};
        const params = operation.parameters || [];
        for (const param of params) {
            parsedParams.properties.parameters.properties[param.name] = {

                description: param.description || 'No description',
                ...param.schema
            };
        }

        if(operation.requestBody) {
            const requestBody = operation.requestBody;
            if(requestBody.content) {
                const content = Object.values(requestBody.content)[0];
                parsedParams.properties.requestBody.properties = {
                    description: requestBody.description || 'No description',
                    ...content.schema
                };
            }
        }

        return Object.keys(parsedParams).length === 0? null : parsedParams;
    }

    async init() {
        const client = await Swagger(this.openApiUrl);
        const spec = client.spec;
        const requestOptions = {
            requestInterceptor: (req) => {
                if (this.headers !== undefined) {
                    for (const [key, value] of Object.entries(this.headers)) {
                        req.headers[key] = value;
                    }
                }
                return req;
            }
        };
        for (const [path, methods] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(methods)) {
                if(!operation || !operation.operationId) {
                    continue;
                }
                const tag = (operation.tags && operation.tags[0]) || 'default';
                let operationId = operation.operationId;
                operation.parameters?.forEach((parameter) => {
                    if (parameter.in === 'path') {
                        operationId = `${operationId}_by_${parameter.name}`;
                    }
                })

                const parametersParsed = this.#parseParams(operation);
                this.mcpProxy.registerJsFunction({
                    name: operationId,
                    description: operation.description || 'No description',
                    inputSchema: parametersParsed,
                    fn: async (args) => {
                        try {

                            const res = await client.apis[tag][operation.operationId](args.parameters,{...requestOptions, requestBody: args.requestBody});
                            return {content: [
                                    {
                                        type: "text",
                                        text: JSON.stringify(res.data)
                                    }
                                ]}
                        } catch (err) {
                            console.error(`Error calling ${operationId}:`, err);
                            throw err;
                        }
                    }
                })
            }
        }
        await this.mcpProxy.startMCP();
    }


}

async function main() {
    const openapi = new OpenApiMcp({
        openApiUrl: "https://petstore.swagger.io/v2/swagger.json",
        apiDescription:"Api used to manage a pet store with access to pets, pet types, users, orders and store",
        headers: {
            Authorization: "Bearer apikey"
        }
    });
    await openapi.init();
}

main()
