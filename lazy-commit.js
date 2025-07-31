#!/usr/bin/env node

const { execSync } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Polyfill for fetch if not available (Node.js < 18)
let fetch;
try {
  fetch = globalThis.fetch;
} catch (e) {
  // Fallback for older Node.js versions
}

if (!fetch) {
  try {
    const https = require("https");
    const http = require("http");

    fetch = async (url, options = {}) => {
      return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https:") ? https : http;
        const urlObj = new URL(url);

        const reqOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: options.method || "GET",
          headers: options.headers || {},
        };

        const req = protocol.request(reqOptions, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage,
              json: async () => JSON.parse(data),
              text: async () => data,
            });
          });
        });

        req.on("error", reject);

        if (options.body) {
          req.write(options.body);
        }

        req.end();
      });
    };
  } catch (e) {
    console.error(
      "❌ Unable to initialize HTTP client. Please update to Node.js 18+ or install node-fetch."
    );
    process.exit(1);
  }
}

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OLLAMA_API_URL = "http://localhost:11434/api";
const CONFIG_DIR = path.join(os.homedir(), ".auto-commit");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const API_KEY_FILE = path.join(CONFIG_DIR, "api-key");

const OPENROUTER_MODELS = [{ name: "Custom (enter manually)", id: "custom" }];

const PROVIDERS = {
  OPENROUTER: "openrouter",
  OLLAMA: "ollama",
};

const COMMIT_PATTERN = `IMPORTANT: Generate a detailed conventional commit message for the following changes. Ensure the message adheres to the type(scope): brief summary format and includes 2-5 concise, action-oriented bullet points detailing specific modifications made in the codebase. Each bullet should clearly state what was changed, using verbs like 'add,' 'remove,' 'update,' 'fix,' or 'refactor.'

FORMAT: type(scope): brief summary of main change

- A conventional commit type (e.g., feat, fix, refactor).
- A scope for the change (e.g., authentication, UI, database).
- A brief, one-line summary of the main purpose of this commit.
- 2-5 distinct bullet points, each describing a concrete, granular change that was implemented. Focus on what was modified in the code, using strong action verbs.

REQUIREMENTS:
- Use conventional commit format: type(scope): description
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
- Include 2-5 bullet points detailing SPECIFIC changes
- Each bullet should be concise but descriptive
- Focus on WHAT was changed, not just WHY
- Use action verbs (add, remove, update, fix, refactor, etc.)

Make each bullet point specific and actionable, showing exactly what was modified in the codebase.`;

function validateStagedChanges(diff) {
  const sensitivePatterns = [
    /OPENROUTER_API_KEY\s*=\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
    /api[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
    /token\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
    /secret\s*[=:]\s*["']?[a-zA-Z0-9_\-]{20,}["']?/gi,
    /password\s*[=:]\s*["']?[^\\s"']+["']?/gi,
    /private[_-]?key\s*[=:]/gi,
    /\+.*\.env/gi,
    /\+.*\.env\./gi,
    /["'][a-zA-Z0-9+/=]{32,}["']/g,
  ];

  const suspiciousLines = [];
  const lines = diff.split("\n");

  lines.forEach((line, index) => {
    if (line.startsWith("+")) {
      sensitivePatterns.forEach((pattern) => {
        if (pattern.test(line)) {
          suspiciousLines.push({
            lineNumber: index + 1,
            content: line.trim(),
            pattern: pattern.source,
          });
        }
      });
    }
  });

  if (suspiciousLines.length > 0) {
    console.error("\n🚨 SECURITY WARNING: Potential sensitive data detected!");
    console.error("═".repeat(60));
    suspiciousLines.forEach((item) => {
      console.error(`Line ${item.lineNumber}: ${item.content}`);
    });
    console.error("═".repeat(60));
    console.error("");
    console.error(
      "Please review these changes and ensure no secrets are being committed."
    );
    console.error(
      "Consider adding sensitive files to .gitignore or using environment variables."
    );
    console.error("");
    throw new Error("Commit blocked due to potential sensitive data");
  }
}

async function getStagedDiff() {
  const spinner = createSpinner("Checking staged changes...");
  try {
    const diff = execSync("git diff --staged", { encoding: "utf8" });
    if (!diff.trim()) {
      spinner.fail("No staged changes found");
      console.log("💡 Stage some changes first with: git add <files>");

      const continueChoice = await promptUser(
        "\nWould you like to (c)ontinue waiting for changes or (q)uit? "
      );
      if (continueChoice === "q" || continueChoice === "quit") {
        throw new Error("User chose to quit - no staged changes");
      }

      // If user chose to continue, throw error to trigger retry loop
      throw new Error("No staged changes found");
    }

    validateStagedChanges(diff);
    spinner.stop("✅ Staged changes validated");
    return diff;
  } catch (error) {
    if (error.message.includes("sensitive data")) {
      spinner.fail("Sensitive data detected");
      throw error;
    }
    if (error.message.includes("User chose to quit")) {
      throw error;
    }
    if (error.message.includes("No staged changes found")) {
      throw error;
    }
    spinner.fail("Error checking staged changes");
    console.error("Error getting staged diff:", error.message);
    throw error;
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return config;
    }
  } catch (error) {
    console.warn("Warning: Could not load config file");
  }
  return {
    customModels: [],
    lastProvider: null,
    lastModel: null,
    lastOllamaModel: null,
    autoUseLastChoice: false,
    skipProviderPrompt: false,
    skipModelPrompt: false,
  };
}

function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.warn("Warning: Could not save config file");
  }
}

function createSpinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const spinner = setInterval(() => {
    process.stdout.write(`\r${frames[i]} ${text}`);
    i = (i + 1) % frames.length;
  }, 100);

  return {
    stop: (finalText) => {
      clearInterval(spinner);
      process.stdout.write(`\r${finalText || text}\n`);
    },
    fail: (errorText) => {
      clearInterval(spinner);
      process.stdout.write(`\r❌ ${errorText}\n`);
    },
  };
}

async function fetchOllamaModels(retryCount = 0) {
  const maxRetries = 2;
  const spinner = createSpinner("Fetching Ollama models...");

  try {
    const response = await fetch(`${OLLAMA_API_URL}/tags`);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    const data = await response.json();
    spinner.stop("✅ Ollama models loaded");
    return data.models || [];
  } catch (error) {
    spinner.fail("Failed to connect to Ollama");

    if (retryCount < maxRetries) {
      console.log(`\n🔄 Retrying... (${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await fetchOllamaModels(retryCount + 1);
    }

    console.warn("\n⚠️  Could not connect to Ollama after multiple attempts.");
    console.warn("   Make sure Ollama is running: ollama serve");
    console.warn("   Check available models: ollama list");

    const rl = createInterface();
    const retry = await new Promise((resolve) => {
      rl.question(
        "\nWould you like to (r)etry, (s)witch to OpenRouter, or (q)uit? ",
        (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase());
        }
      );
    });

    if (retry === "r" || retry === "retry") {
      return await fetchOllamaModels(0);
    } else if (retry === "s" || retry === "switch") {
      return "SWITCH_TO_OPENROUTER";
    } else {
      process.exit(1);
    }
  }
}

async function selectProvider(config) {
  // Auto-use last choice if configured
  if (
    config.autoUseLastChoice &&
    config.lastProvider &&
    !config.skipProviderPrompt
  ) {
    console.log(
      `\n🔌 Using last provider: ${
        config.lastProvider === PROVIDERS.OLLAMA
          ? "Ollama (Local AI)"
          : "OpenRouter (Cloud AI)"
      }`
    );
    return config.lastProvider;
  }

  const providers = [
    { name: "🌐 OpenRouter (Cloud AI)", value: PROVIDERS.OPENROUTER },
    { name: "🖥️  Ollama (Local AI)", value: PROVIDERS.OLLAMA },
  ];

  console.log("\n🔌 Select AI Provider:");
  providers.forEach((provider, index) => {
    const isLast = config.lastProvider === provider.value;
    console.log(
      `${index + 1}. ${provider.name}${isLast ? " (last used)" : ""}`
    );
  });

  console.log("\n💡 Options:");
  console.log("   - Add 'r' to remember choice and don't ask again");
  console.log("   - Add 's' to skip provider selection in future");
  console.log("   - Type 'q' to quit");

  const rl = createInterface();
  return new Promise((resolve) => {
    const defaultChoice = config.lastProvider === PROVIDERS.OLLAMA ? 2 : 1;
    rl.question(
      `\nEnter provider number (default: ${defaultChoice}): `,
      (answer) => {
        rl.close();

        const input = answer.trim().toLowerCase();

        if (input === "q" || input === "quit") {
          console.log("👋 Goodbye!");
          process.exit(0);
        }

        const hasRemember = input.includes("r");
        const hasSkip = input.includes("s");

        // Extract number from input
        const choice = parseInt(input) || defaultChoice;

        if (choice < 1 || choice > providers.length) {
          console.log("Invalid choice, using OpenRouter");
          resolve(PROVIDERS.OPENROUTER);
          return;
        }

        const selectedProvider = providers[choice - 1].value;

        // Update config based on flags
        if (hasRemember) {
          config.autoUseLastChoice = true;
          console.log("✅ Will remember this choice for future runs");
        }

        if (hasSkip) {
          config.skipProviderPrompt = true;
          console.log("✅ Will skip provider selection in future");
        }

        if (hasRemember || hasSkip) {
          saveConfig(config);
        }

        resolve(selectedProvider);
      }
    );
  });
}

async function selectModel() {
  const config = loadConfig();
  const selectedProvider = await selectProvider(config);

  config.lastProvider = selectedProvider;
  saveConfig(config);

  if (selectedProvider === PROVIDERS.OLLAMA) {
    return await selectOllamaModel(config);
  } else {
    return await selectOpenRouterModel(config);
  }
}

async function selectOllamaModel(config) {
  const ollamaModels = await fetchOllamaModels();

  if (ollamaModels === "SWITCH_TO_OPENROUTER") {
    config.lastProvider = PROVIDERS.OPENROUTER;
    saveConfig(config);
    return await selectOpenRouterModel(config);
  }

  if (ollamaModels.length === 0) {
    console.log(
      "❌ No Ollama models found. Make sure Ollama is running and you have models installed."
    );
    console.log("   Run 'ollama list' to see available models");
    process.exit(1);
  }

  // Auto-use last model if configured
  if (
    config.autoUseLastChoice &&
    config.lastOllamaModel &&
    !config.skipModelPrompt
  ) {
    const lastModel = ollamaModels.find(
      (m) => m.name === config.lastOllamaModel
    );
    if (lastModel) {
      console.log(`\n🤖 Using last model: ${lastModel.name}`);
      return { model: lastModel.name, provider: PROVIDERS.OLLAMA };
    }
  }

  console.log("\n🤖 Select Ollama model:");
  ollamaModels.forEach((model, index) => {
    const isLast = config.lastOllamaModel === model.name;
    const sizeInfo = model.size ? ` (${(model.size / 1e9).toFixed(1)}GB)` : "";
    console.log(
      `${index + 1}. ${model.name}${sizeInfo}${isLast ? " (last used)" : ""}`
    );
  });

  console.log("\n💡 Options:");
  console.log("   - Add 'r' to remember choice and don't ask again");
  console.log("   - Add 's' to skip model selection in future");
  console.log("   - Type 'q' to quit");

  const rl = createInterface();
  return new Promise((resolve) => {
    const lastModelIndex = ollamaModels.findIndex(
      (m) => m.name === config.lastOllamaModel
    );
    const defaultChoice = lastModelIndex >= 0 ? lastModelIndex + 1 : 1;

    rl.question(
      `\nEnter model number (default: ${defaultChoice}): `,
      (answer) => {
        rl.close();

        const input = answer.trim().toLowerCase();

        if (input === "q" || input === "quit") {
          console.log("👋 Goodbye!");
          process.exit(0);
        }

        const hasRemember = input.includes("r");
        const hasSkip = input.includes("s");

        const choice = parseInt(input) || defaultChoice;
        if (choice < 1 || choice > ollamaModels.length) {
          console.log("Invalid choice, using first model");
          config.lastOllamaModel = ollamaModels[0].name;
          saveConfig(config);
          resolve({ model: ollamaModels[0].name, provider: PROVIDERS.OLLAMA });
          return;
        }

        const selectedModel = ollamaModels[choice - 1];
        config.lastOllamaModel = selectedModel.name;

        // Update config based on flags
        if (hasRemember) {
          config.autoUseLastChoice = true;
          console.log("✅ Will remember this choice for future runs");
        }

        if (hasSkip) {
          config.skipModelPrompt = true;
          console.log("✅ Will skip model selection in future");
        }

        saveConfig(config);
        resolve({ model: selectedModel.name, provider: PROVIDERS.OLLAMA });
      }
    );
  });
}

async function selectOpenRouterModel(config) {
  const allModels = [...OPENROUTER_MODELS];

  config.customModels.forEach((customModel) => {
    allModels.splice(-1, 0, {
      name: `${customModel.name} (saved)`,
      id: customModel.id,
    });
  });

  // Auto-use last model if configured
  if (config.autoUseLastChoice && config.lastModel && !config.skipModelPrompt) {
    const lastModel = allModels.find((m) => m.id === config.lastModel);
    if (lastModel) {
      console.log(`\n🤖 Using last model: ${lastModel.name}`);
      return { model: lastModel.id, provider: PROVIDERS.OPENROUTER };
    }
  }

  console.log("\n🤖 Select OpenRouter model:");
  allModels.forEach((model, index) => {
    const isLast = config.lastModel === model.id;
    console.log(`${index + 1}. ${model.name}${isLast ? " (last used)" : ""}`);
  });

  console.log("\n💡 Options:");
  console.log("   - Add 'r' to remember choice and don't ask again");
  console.log("   - Add 's' to skip model selection in future");
  console.log("   - Type 'q' to quit");

  const rl = createInterface();
  return new Promise((resolve) => {
    const lastModelIndex = allModels.findIndex(
      (m) => m.id === config.lastModel
    );
    const defaultChoice = lastModelIndex >= 0 ? lastModelIndex + 1 : 1;

    rl.question(
      `\nEnter model number (default: ${defaultChoice}): `,
      async (answer) => {
        rl.close();

        const input = answer.trim().toLowerCase();

        if (input === "q" || input === "quit") {
          console.log("👋 Goodbye!");
          process.exit(0);
        }

        const hasRemember = input.includes("r");
        const hasSkip = input.includes("s");

        const choice = parseInt(input) || defaultChoice;
        if (choice < 1 || choice > allModels.length) {
          console.log("Invalid choice, using default model");
          config.lastModel = OPENROUTER_MODELS[0].id;
          saveConfig(config);
          resolve({
            model: OPENROUTER_MODELS[0].id,
            provider: PROVIDERS.OPENROUTER,
          });
          return;
        }

        const selectedModel = allModels[choice - 1];
        if (selectedModel.id === "custom") {
          const customRl = createInterface();
          customRl.question("Enter custom model ID: ", (customModelId) => {
            const nameRl = createInterface();
            nameRl.question(
              "Enter a name for this model (optional): ",
              (customName) => {
                customRl.close();
                nameRl.close();

                const modelId = customModelId.trim();
                const modelName = customName.trim() || modelId;

                const existingIndex = config.customModels.findIndex(
                  (m) => m.id === modelId
                );
                if (existingIndex === -1) {
                  config.customModels.push({ id: modelId, name: modelName });
                  console.log(`✅ Saved custom model: ${modelName}`);
                }

                config.lastModel = modelId;

                // Update config based on flags
                if (hasRemember) {
                  config.autoUseLastChoice = true;
                  console.log("✅ Will remember this choice for future runs");
                }

                if (hasSkip) {
                  config.skipModelPrompt = true;
                  console.log("✅ Will skip model selection in future");
                }

                saveConfig(config);
                resolve({ model: modelId, provider: PROVIDERS.OPENROUTER });
              }
            );
          });
        } else {
          config.lastModel = selectedModel.id;

          // Update config based on flags
          if (hasRemember) {
            config.autoUseLastChoice = true;
            console.log("✅ Will remember this choice for future runs");
          }

          if (hasSkip) {
            config.skipModelPrompt = true;
            console.log("✅ Will skip model selection in future");
          }

          saveConfig(config);
          resolve({ model: selectedModel.id, provider: PROVIDERS.OPENROUTER });
        }
      }
    );
  });
}

async function generateCommitMessage(diff, apiKey, modelConfig) {
  const contextLength = diff.length;

  // Validate diff content
  if (!diff || diff.trim().length === 0) {
    throw new Error("No changes to generate commit message for");
  }

  // Check if diff is too large (some APIs have limits)
  if (contextLength > 50000) {
    console.warn("⚠️  Large diff detected, commit message may be truncated");
  }

  const prompt = `${COMMIT_PATTERN}

Here are the staged changes (${contextLength} characters):
\`\`\`diff
${diff}
\`\`\`

Generate a conventional commit message based on these changes:`;

  try {
    let result;
    if (modelConfig.provider === PROVIDERS.OLLAMA) {
      result = await generateOllamaCommitMessage(modelConfig.model, prompt);
    } else {
      result = await generateOpenRouterCommitMessage(
        apiKey,
        modelConfig.model,
        prompt
      );
    }

    // Validate the generated message
    if (!result || result.trim().length === 0) {
      throw new Error("Generated commit message is empty");
    }

    // Basic validation for commit message format
    if (result.length > 2000) {
      console.warn(
        "⚠️  Generated commit message is quite long, consider editing it"
      );
    }

    return result;
  } catch (error) {
    console.error("Error generating commit message:", error.message);

    // Check if this is an OpenRouter-specific error that might benefit from model switching
    const isOpenRouterError =
      modelConfig.provider === PROVIDERS.OPENROUTER &&
      (error.message.includes("API error") ||
        error.message.includes("429") ||
        error.message.includes("connection") ||
        error.message.includes("timeout") ||
        error.message.includes("too many"));

    // Ask user if they want to retry
    const rl = createInterface();
    const options = isOpenRouterError
      ? "\nWould you like to (r)etry, (s)witch model/provider, enter (m)anual message, or (q)uit? "
      : "\nWould you like to (r)etry, enter (m)anual message, or (q)uit? ";

    const retry = await new Promise((resolve) => {
      rl.question(options, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    });

    if (retry === "r" || retry === "retry") {
      return await generateCommitMessage(diff, apiKey, modelConfig);
    } else if (retry === "s" || retry === "switch") {
      // Return special error to indicate model switching is needed
      throw new Error("SWITCH_MODEL_REQUESTED");
    } else if (retry === "m" || retry === "manual") {
      const manualRl = createInterface();
      return new Promise((resolve) => {
        manualRl.question("\nEnter your commit message: ", (message) => {
          manualRl.close();
          if (!message.trim()) {
            console.log("Empty message, using default");
            resolve("chore: update files");
          } else {
            resolve(message.trim());
          }
        });
      });
    } else {
      throw new Error("User chose to quit after generation failure");
    }
  }
}

async function generateOllamaCommitMessage(model, prompt) {
  const spinner = createSpinner(`Generating commit message with ${model}...`);

  try {
    const response = await fetch(`${OLLAMA_API_URL}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    let content = data.response.trim();

    content = content.replace(/^```markdown\n?/i, "");
    content = content.replace(/\n?```$/i, "");
    content = content.replace(/^```\n?/i, "");
    content = content.replace(/^diff\n?/i, "");
    content = content.replace(
      /^Here's?\\s+(the|a)\\s+commit\\s+message:?\n?/i,
      ""
    );
    content = content.replace(/^Commit\\s+message:?\n?/i, "");

    spinner.stop("✅ Commit message generated");
    return content.trim();
  } catch (error) {
    spinner.fail("Failed to generate commit message");
    throw error;
  }
}

async function generateOpenRouterCommitMessage(apiKey, model, prompt) {
  const spinner = createSpinner(`Generating commit message with ${model}...`);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Auto Commit Tool",
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      let errorMessage = `OpenRouter API error: ${response.status} ${response.statusText}`;

      // Add more specific error messages for common issues
      if (response.status === 429) {
        errorMessage +=
          " - Rate limit exceeded. Try switching to a different model or provider.";
      } else if (response.status === 401) {
        errorMessage += " - Invalid API key. Check your OpenRouter API key.";
      } else if (response.status === 402) {
        errorMessage +=
          " - Insufficient credits. Check your OpenRouter balance.";
      } else if (response.status === 503) {
        errorMessage +=
          " - Service unavailable. Try a different model or provider.";
      }

      throw new Error(errorMessage);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();

    content = content.replace(/^```markdown\n?/i, "");
    content = content.replace(/\n?```$/i, "");
    content = content.replace(/^```\n?/i, "");
    content = content.replace(/^diff\n?/i, "");
    content = content.replace(
      /^Here's?\\s+(the|a)\\s+commit\\s+message:?\n?/i,
      ""
    );
    content = content.replace(/^Commit\\s+message:?\n?/i, "");

    spinner.stop("✅ Commit message generated");
    return content.trim();
  } catch (error) {
    spinner.fail("Failed to generate commit message");

    // Enhanced error handling for network/connection issues
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      throw new Error(
        `OpenRouter connection failed: Unable to reach openrouter.ai. Check your internet connection.`
      );
    } else if (error.code === "ETIMEDOUT") {
      throw new Error(
        `OpenRouter timeout: Request took too long. The service may be experiencing issues.`
      );
    } else if (error.name === "TypeError" && error.message.includes("fetch")) {
      throw new Error(
        `OpenRouter network error: ${error.message}. Check your internet connection.`
      );
    }

    throw error;
  }
}

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function promptUser(message) {
  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function enhancedEditMenu(originalMessage) {
  console.log("\n📝 Edit Menu:");
  console.log("1. Edit the entire message");
  console.log("2. Edit just the title/summary");
  console.log("3. Edit just the bullet points");
  console.log("4. Use the message as-is");

  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question("\nChoose an option (1-4, default: 4): ", async (choice) => {
      rl.close();

      const option = parseInt(choice.trim()) || 4;

      switch (option) {
        case 1:
          const fullEdit = await promptForEdit(
            "Enter your complete commit message:",
            originalMessage
          );
          resolve(fullEdit);
          break;

        case 2:
          const lines = originalMessage.split("\n");
          const title = lines[0] || "";
          const rest = lines.slice(1).join("\n");
          const newTitle = await promptForEdit(
            "Enter new title/summary:",
            title
          );
          resolve(newTitle + "\n" + rest);
          break;

        case 3:
          const messageParts = originalMessage.split("\n");
          const bulletStart = messageParts.findIndex((line) =>
            line.trim().startsWith("•")
          );
          const beforeBullets = messageParts.slice(0, bulletStart).join("\n");
          const bullets = messageParts.slice(bulletStart).join("\n");
          const newBullets = await promptForEdit(
            "Enter new bullet points:",
            bullets
          );
          resolve(beforeBullets + "\n" + newBullets);
          break;

        default:
          resolve(originalMessage);
      }
    });
  });
}

async function promptForEdit(prompt, defaultValue) {
  const rl = createInterface();
  return new Promise((resolve) => {
    console.log(`\n${prompt}`);
    console.log(
      "(Current value shown below, press Enter to keep, or type new value)"
    );
    console.log("─".repeat(50));
    console.log(defaultValue);
    console.log("─".repeat(50));

    rl.question("\nNew value (Enter to keep current): ", (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function commitChanges(message) {
  const spinner = createSpinner("Committing changes...");
  try {
    // Use a more robust approach with file-based commit message
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    // Create temporary file for commit message
    const tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, message, "utf8");

    try {
      execSync(`git commit -F "${tempFile}"`, {
        encoding: "utf8",
        stdio: "inherit",
      });
      spinner.stop("✅ Changes committed successfully!");
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    spinner.fail("Failed to commit changes");
    console.error("Error committing changes:", error.message);
    throw error; // Don't exit, let the main loop handle it
  }
}

async function getApiKey() {
  let apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    return apiKey;
  }

  try {
    if (fs.existsSync(API_KEY_FILE)) {
      apiKey = fs.readFileSync(API_KEY_FILE, "utf8").trim();
      if (apiKey) {
        return apiKey;
      }
    }
  } catch (error) {
    // Ignore read errors, we'll prompt for the key
  }

  console.log("\n🔑 OpenRouter API key not found.");
  console.log("You can get one at: https://openrouter.ai/keys");

  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question("\nEnter your OpenRouter API key: ", (key) => {
      rl.close();

      if (!key.trim()) {
        console.error("❌ API key is required");
        process.exit(1);
      }

      try {
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(API_KEY_FILE, key.trim());
        console.log("✅ API key saved globally for future use");
      } catch (error) {
        console.warn(
          "⚠️  Could not save API key, you'll need to enter it again next time"
        );
      }

      resolve(key.trim());
    });
  });
}

function resetConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log("✅ Configuration reset successfully!");
    } else {
      console.log("ℹ️  No configuration file found to reset.");
    }
  } catch (error) {
    console.error("❌ Failed to reset configuration:", error.message);
  }
}

function displayBanner() {
  const banner = `
┌─────────────────────────────────────────────────────────────┐
│                        THE LAZY-GIT.                        │
│                    an @oroooat Production                   │
└─────────────────────────────────────────────────────────────┘

╭─────────────────────────────────────────────────────────────────╮
│                                                                 │
│    ██╗      █████╗ ███████╗██╗   ██╗     ██████╗ ██╗████████╗   │
│    ██║     ██╔══██╗╚══███╔╝╚██╗ ██╔╝    ██╔════╝ ██║╚══██╔══╝   │
│    ██║     ███████║  ███╔╝  ╚████╔╝     ██║  ███╗██║   ██║      │
│    ██║     ██╔══██║ ███╔╝    ╚██╔╝      ██║   ██║██║   ██║      │
│    ███████╗██║  ██║███████╗   ██║       ╚██████╔╝██║   ██║      │
│    ╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝        ╚═════╝ ╚═╝   ╚═╝      │
│                                                                 │
╰─────────────────────────────────────────────────────────────────╯
`;

  console.log("\x1b[38;2;217;165;145m" + banner + "\x1b[0m");
}

async function main() {
  // Check for command line arguments
  const args = process.argv.slice(2);
  if (args.includes("--reset-config") || args.includes("-r")) {
    resetConfig();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Lazy Commit - AI-powered commit message generator

Usage:
  lazy-commit                    Generate commit message
  lazy-commit --reset-config     Reset all saved preferences
  lazy-commit --help             Show this help message

Options:
  -r, --reset-config    Reset configuration and preferences
  -h, --help           Show help information

To remember choices, add 'r' to your selection (e.g., "1r")
To skip prompts in future, add 's' to your selection (e.g., "2s")

During operation:
  Type 'q' at any prompt to quit
  Press CTRL+C to exit
`);
    return;
  }

  // Setup CTRL+C handler
  process.on("SIGINT", () => {
    console.log("\n\n👋 Goodbye!");
    process.exit(0);
  });

  displayBanner();

  // Main loop - continue until user exits
  while (true) {
    try {
      const diff = await getStagedDiff();
      let modelConfig = await selectModel();
      let apiKey = null;

      // Inner loop to handle model switching on failures
      let commitMessage;
      while (true) {
        try {
          if (modelConfig.provider === PROVIDERS.OPENROUTER) {
            apiKey = await getApiKey();
          }

          commitMessage = await generateCommitMessage(
            diff,
            apiKey,
            modelConfig
          );
          break; // Success, exit model retry loop
        } catch (error) {
          if (error.message === "SWITCH_MODEL_REQUESTED") {
            console.log("\n🔄 Switching model/provider...");
            modelConfig = await selectModel();
            continue; // Try again with new model
          } else {
            throw error; // Re-throw other errors to be handled by outer catch
          }
        }
      }

      console.log("\n📝 Generated commit message:");
      console.log("─".repeat(50));
      console.log(commitMessage);
      console.log("─".repeat(50));

      const action = await promptUser(
        "\nChoose an action: (a)ccept, (e)dit, (c)ancel, (q)uit: "
      );

      if (action === "q" || action === "quit") {
        console.log("👋 Goodbye!");
        break;
      } else if (action === "a" || action === "accept") {
        await commitChanges(commitMessage);
        console.log(
          "\n🎉 Ready for next commit! Stage some changes or press CTRL+C to exit."
        );
      } else if (action === "e" || action === "edit") {
        const editedMessage = await enhancedEditMenu(commitMessage);
        if (editedMessage.trim()) {
          await commitChanges(editedMessage);
          console.log(
            "\n🎉 Ready for next commit! Stage some changes or press CTRL+C to exit."
          );
        } else {
          console.log("❌ Empty commit message. Cancelled.");
        }
      } else {
        console.log("❌ Commit cancelled.");
      }
    } catch (error) {
      if (error.message.includes("User chose to quit")) {
        console.log("👋 Goodbye!");
        break;
      } else if (error.message.includes("No staged changes found")) {
        // Just continue the loop, the user already chose to continue in getStagedDiff
        continue;
      } else if (error.message.includes("sensitive data")) {
        console.log("\n⚠️  Commit blocked due to sensitive data detection.");
        console.log(
          "Please review and remove sensitive information before committing."
        );
        const continueChoice = await promptUser(
          "Fix the issues and try again, or (q)uit? "
        );
        if (continueChoice === "q" || continueChoice === "quit") {
          console.log("👋 Goodbye!");
          break;
        }
      } else if (error.message.includes("Failed to commit changes")) {
        console.log("\n❌ Commit failed. Please check for git errors above.");
        const continueChoice = await promptUser("Try again or (q)uit? ");
        if (continueChoice === "q" || continueChoice === "quit") {
          console.log("👋 Goodbye!");
          break;
        }
      } else {
        console.error("\n❌ Unexpected error:", error.message);
        const continueChoice = await promptUser("Continue or (q)uit? ");
        if (continueChoice === "q" || continueChoice === "quit") {
          console.log("👋 Goodbye!");
          break;
        }
      }
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getStagedDiff, generateCommitMessage, commitChanges };
