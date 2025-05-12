import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path"; // Corrected from 'fs' to 'path'
import which from "which"; // Corrected from 'with' to 'which'
import fs from "fs"; // Added proper fs import
import process from "node:process"; // Import process from Node.js
// Import MiniSearch for local indexing
import MiniSearch from "minisearch";

import { z } from "zod";
const VERSION = "1.0.0";
const DISCOVER_DESCRIPTION = "Discover enables you the possibility to find other tools. " +
    "You will required to send a context that can be composed on multiple sentences as short as possible with the synthesis of the requirements you need to look for a tool. " +
    "If tools are found they will be returned as json array indicating their name, description and parameters. " +
    "To use the returned tools you will need to call the execute method indicating the toolID, method and the parameters to be used.";
const DEFAULT_DISCOVER_LIMIT=5;

export class MCPProxy {
    constructor({ mcpServers, discoverDescription = null, discoverDescriptionExtras = null, discoverLimit = null }) {
        this.mcpServers = mcpServers;
        this.clients = {};
        this.allTools = {}; // Store all tools from all servers
        this.toolsIndex = new MiniSearch({
            fields: ['method', 'description', 'parameterDescriptions'], // Fields to index
            storeFields: ['toolId','method', 'description', 'parameterDescriptions'], // Fields to return with search results
            searchOptions: {
                boost: { description: 2 }, // Boost matches in description
                fuzzy: 0.2 // Allow some fuzzy matching
            }
        }); // Will hold our search index
        this.discoverDescription = discoverDescription || DISCOVER_DESCRIPTION;
        this.discoverDescriptionExtras = discoverDescriptionExtras;
        this.discoverLimit = discoverLimit || DEFAULT_DISCOVER_LIMIT;
        this.mcpIndex = {};
        this.jsFunctions = {};
        // Bind methods to this instance
        this.discover = this.discover.bind(this);
        this.execute = this.execute.bind(this);
    }

    registerJsFunction({name, description, inputSchema, fn}) {
        this.jsFunctions[name] = {
            name,
            description,
            inputSchema,
            fn
        };

        // If the index is already created, update it
        if (this.toolsIndex) {
            this.#addJsFunctionToIndex(name, description, inputSchema);
        }

        return this;
    }
    /**
     * Add a JavaScript function to the search index
     * @param {string} name - Function name
     * @param {string} description - Function description
     * @param {Object} inputSchema - Input schema for the function
     */
    #addJsFunctionToIndex(name, description, inputSchema) {
        const parameterDescriptions = this.extractParameterDescriptions(inputSchema);

        this.toolsIndex.add({
            id: `js::${name}`,
            toolId: 'js',
            method: name,
            description,
            parameterDescriptions,
            parameters: inputSchema
        });
    }
    /**
     * Discover tools based on query strings
     * @param {Object} params - The parameters object
     * @param {string[]} params.queries - Array of query strings to search for tools
     * @returns {Array} - Array of matching tools
     */
    async discover({ queries }) {
        if (!this.toolsIndex || this.toolsIndex.documentCount == 0) {
            console.error("No tools indexed yet. Make sure loadMCPServers has been called.");
            return [];
        }

        // Combine all queries and search
        const combinedQuery = queries.join(" ");

        // Search the index with the combined query
        const searchResults = this.toolsIndex.search(combinedQuery, {
            fuzzy: 0.1, // Allow some typos and fuzzy matching
            prefix: true, // Match by prefix
            boost: { description: 2 }, // Boost matches in description
            combineWith: 'OR', // Match any of the terms
        });
        const filteredResults = searchResults
            .slice(0, this.discoverLimit);
        // Return the formatted results
        const result = filteredResults.map(result => {
            const [serverName, toolName] = result.id.split('::');
            if (serverName === 'js') {
                // Return JavaScript function schema
                return {
                    toolId: serverName,
                    method: toolName,
                    inputSchema: this.jsFunctions[toolName].inputSchema,
                };
            } else {
                // Return MCP server schema
                return {
                    toolId: serverName,
                    method: toolName,
                    inputSchema: this.mcpIndex[serverName].tools[toolName].inputSchema,
                };
            }
        });
        return {content: [
            {
                type: "text",
                text: JSON.stringify(result)
            }
        ]}
    }

    async resolveCommandPath(command) {
        // If already absolute, return as is
        if (path.isAbsolute(command)) {
            return command;
        }

        try {
            // Try to find the command in PATH using 'which'
            const resolvedPath = await which(command);
            return resolvedPath;
        } catch (whichError) {
            // 'which' failed to find the command in PATH
            console.error(`Command '${command}' not found in PATH: ${whichError.message}`);

            // Check if the command is relative to current directory
            const currentDirPath = path.join(process.cwd(), command);
            try {
                const stats = await fs.promises.stat(currentDirPath);
                if (stats.isFile()) {
                    return currentDirPath;
                }
            } catch (fsError) {
                // Not in current directory either
            }

            // Return the original command if we couldn't resolve it
            // This will likely fail when executed, but preserves the original behavior
            return command;
        }
    }
    /**
     * Execute a specific tool method
     * @param {Object} params - The parameters object
     * @param {string} params.toolId - The server ID
     * @param {string} params.method - The tool method to execute
     * @param {Object} params.args - Arguments to pass to the tool
     * @returns {Object} - The result from the tool execution
     */
    async execute({ toolId, method, args },contextFn = null) {
        // Handle JavaScript functions
        if (toolId === 'js') {
            if (!this.jsFunctions[method]) {
                throw new Error(`JavaScript function '${method}' not found. Available functions: ${Object.keys(this.jsFunctions).join(', ')}`);
            }

            try {
                let context = null;
                if(contextFn) {
                    context = await contextFn();
                }
                const result = await this.jsFunctions[method].fn(args, context);
                return result;
            } catch (error) {
                console.error(`Error executing JavaScript function '${method}':`, error);
                throw error;
            }
        }

        // Handle MCP servers
        if (!this.clients[toolId]) {
            throw new Error(`Tool ID ${toolId} not found. Available tools: ${Object.keys(this.clients).join(', ')}`);
        }

        return await this.clients[toolId].callTool({ name: method, arguments: args });
    }

    /**
     * Create a searchable index from all tools
     * @param {Object} tools - Object containing all tools from all servers
     */
    indexMCPS(mcp) {
        // Format and add all tools to the index
        const indexableTools =[];
        Object.entries(this.mcpIndex).map(([id, obj]) => {
            // Extract parameter descriptions for better search
            Object.keys(obj?.tools).forEach((toolName) => {
                const tool = obj?.tools[toolName];
                const parameterDescriptions = this.extractParameterDescriptions(tool.inputSchema);

                indexableTools.push( {
                    id: id+"::"+tool.name,
                    toolId: id,
                    method: tool.name,
                    description: tool.description,
                    parameterDescriptions,
                    parameters: tool.parameters
                });
            })

        });

        // Add all tools to the index
        this.toolsIndex.addAll(indexableTools);
    }

    /**
     * Extract descriptions from parameters for better indexing
     * @param {Object} parameters - The parameters object
     * @returns {string} - Concatenated descriptions
     */
    extractParameterDescriptions(parameters) {
        if (!parameters) return '';

        // Extract descriptions from parameters and join them
        let descriptions = [];

        if (parameters.properties) {
            Object.entries(parameters.properties).forEach(([paramName, paramInfo]) => {
                if (paramInfo.description) {
                    descriptions.push(paramInfo.description);
                }
            });
        }

        return descriptions.join('\n');
    }

    /**
     * Load all MCP servers and index their tools
     */
    async loadMCPServers() {
        if(!this.mcpServers) {
            return;
        }
        const promises = Object.keys(this.mcpServers).map(async serverName => {
            const server = this.mcpServers[serverName];
            let transportProtocol = server.transport || "stdio";
            delete server.transport;
            server.command = await this.resolveCommandPath(server.command);

            let transport;
            switch (transportProtocol) {
                case "stdio":
                    transport = new StdioClientTransport({
                        command: server.command,
                        args: server.args,
                        env: server.env,

                    });
                    break;
                default:
                    throw new Error(`Unknown transport ${server.transport}`);
            }
            const client = new Client({
                name: serverName,
                version: "1.0.0"
            });

            await client.connect(transport);
            this.clients[serverName] = client;
            this.mcpIndex[serverName] = {client, tools:{}};
            // Get all tools from this server
            const tools = await client.listTools();

            // Store tools with a unique ID format: "serverName::toolName"
            Object.keys(tools).forEach(toolName => {
                const uniqueId = `${serverName}`;
                tools[toolName].forEach(tool => {
                    this.mcpIndex[serverName].tools[tool.name] = tool;

                })
            });

            console.error(`Loaded ${Object.keys(tools).length} tools from ${serverName}`);
            return tools;
        });

        await Promise.all(promises);
        console.error(`Total tools loaded: ${Object.keys(this.allTools).length}`);

        // Create the search index now that we have all the tools
        this.indexMCPS(this.mcpIndex);
    }

    async createMCPServer({loadMCPServers = true}) {
        if(loadMCPServers) {
            await this.loadMCPServers();
        }

        const server = new McpServer({
            name: "Meta mcp proxy to discover and route multiple tools",
            version: VERSION,
        });

        let discoverDescription = this.discoverDescription || DISCOVER_DESCRIPTION;
        if (this.discoverDescriptionExtras) {
            discoverDescription += "\n" + this.discoverDescriptionExtras;
        }

        server.tool("discover",
            discoverDescription,
            { queries: z.array(z.string().describe("Sentence used to query for tools, they should be as short and concise as possible")).describe("List of sentence of intentions to discover if there tools available that can be used") },
            this.discover
        );

        server.tool("execute", "execute a tools, this method will act as proxy to call the required tool method with the right parameters",
            { toolId: z.string().describe("Tool id to execute"),
                method: z.string().describe("The tool method to be executed"),
                args: z.object({}).passthrough().describe("Arguments to be passed to the tool") },
            this.execute
        );

        return server;
    }

    /**
     * Start the MCP server
     */
    async startMCP({loadMCPServers = true}={}) {
        const server = await this.createMCPServer({loadMCPServers: true});
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}
