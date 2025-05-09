#!/usr/bin/env node
import { MCPProxy } from './mcp-proxy.js';
import fs from 'fs';
import path from 'path';

// Function to parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        configFile: null,
        configString: null
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--config':
            case '-c':
                options.configFile = args[++i];
                break;
            case '--json':
            case '-j':
                options.configString = args[++i];
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
        }
    }

    return options;
}

// Print help information
function printHelp() {
    console.log(`
    MCP Proxy - A proxy for Model Context Protocol servers

    Usage:
      node index.js [options]

    Options:
      -c, --config <file>    Load configuration from a JSON file
      -j, --json <string>    Load configuration from a JSON string
      -h, --help             Display this help message

    Example:
      node index.js --config ./config.json
      node index.js --json '{"mcpServers":{"server1":{"command":"command"}}}'
    `);
}

// Load configuration from file or string
function loadConfig(options) {
    let config = {
        mcpServers: {},
        discoverDescription: null,
        discoverDescriptionExtras: null,
        discoverLimit: null
    };

    if (options.configFile) {
        try {
            const configPath = path.resolve(options.configFile);
            const fileContent = fs.readFileSync(configPath, 'utf8');
            const fileConfig = JSON.parse(fileContent);
            config = { ...config, ...fileConfig };
        } catch (error) {
            console.error(`Error loading config file: ${error.message}`);
            process.exit(1);
        }
    } else if (options.configString) {
        try {
            const stringConfig = JSON.parse(options.configString);
            config = { ...config, ...stringConfig };
        } catch (error) {
            console.error(`Error parsing config string: ${error.message}`);
            process.exit(1);
        }
    } else {
        console.error('No configuration provided. Use --config or --json');
        printHelp();
        process.exit(1);
    }

    return config;
}

// Main function
async function main() {
    const options = parseArgs();
    const config = loadConfig(options);
    const mcpProxy = new MCPProxy(config);
    await mcpProxy.startMCP();
}

// Run the main function
main().catch(error => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
});