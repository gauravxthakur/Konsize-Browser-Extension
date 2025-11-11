document.getElementById("summarize").addEventListener("click", async () => {
  const resultDiv = document.getElementById("result");
  resultDiv.innerHTML = '<div class="loading"><div class="loader"></div></div>';

  const summaryType = document.getElementById("summary-type").value;

  // Get API key from storage
  chrome.storage.sync.get(["geminiApiKey"], async (result) => {
    if (!result.geminiApiKey) {
      resultDiv.innerHTML =
        "API key not found. Please set your API key in the extension options.";
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_ARTICLE_TEXT" },
        async (res) => {
          if (!res || !res.text) {
            resultDiv.innerText =
              "Could not extract article text from this page.";
            return;
          }

          try {
            const summary = await getGeminiSummary(
              res.text,
              summaryType,
              result.geminiApiKey
            );

            // Clear result container and add content wrapper so we can append the export button
            resultDiv.innerHTML = "";
            const contentEl = document.createElement("div");
            contentEl.id = "result-content";
            contentEl.style.whiteSpace = "pre-wrap";
            contentEl.style.lineHeight = "1.5";
            contentEl.innerText = summary;
            resultDiv.appendChild(contentEl);

            // Remove existing export and narrate buttons if present
            const existing = document.getElementById("export-docs-btn");
            if (existing) existing.remove();
            const existingNarrate = document.getElementById("narrate-btn");
            if (existingNarrate) existingNarrate.remove();

            // Create Export to Docs button
            const exportBtn = document.createElement("button");
            exportBtn.id = "export-docs-btn";
            exportBtn.innerText = "Export to Docs";
            exportBtn.title = "Copy summary and open a new Google Docs tab (then paste).";

            exportBtn.addEventListener("click", async () => {
              const summaryText = contentEl.innerText || "";
              if (!summaryText || summaryText.trim() === "") return;

              try {
                // Copy to clipboard (user gesture)
                await navigator.clipboard.writeText(summaryText);

                // Open a new Google Docs document in a new tab
                // Using chrome.tabs.create to ensure it opens as a tab from the extension
                if (chrome && chrome.tabs && chrome.tabs.create) {
                  chrome.tabs.create({ url: "https://docs.google.com/document/create" });
                } else {
                  window.open("https://docs.google.com/document/create", "_blank");
                }

                const previous = exportBtn.innerText;
                exportBtn.innerText = "Opened — paste (Ctrl+V)";
                setTimeout(() => (exportBtn.innerText = previous), 3000);
              } catch (err) {
                console.error("Export to Docs failed:", err);
                exportBtn.innerText = "Failed — try copying manually";
                setTimeout(() => (exportBtn.innerText = "Export to Docs"), 3000);
              }
            });

            resultDiv.appendChild(exportBtn);

            // Create Narrate (text-to-speech) button
            const narrateBtn = document.createElement("button");
            narrateBtn.id = "narrate-btn";
            narrateBtn.innerText = "Narrate";
            narrateBtn.title = "Read the summary aloud (click to pause/resume).";

            // Keep a reference to the current utterance so we can pause/resume/stop
            let currentUtterance = null;

            function resetNarrateButton() {
              narrateBtn.innerText = "Narrate";
            }

            narrateBtn.addEventListener("click", () => {
              const text = contentEl.innerText || "";
              if (!text || text.trim() === "") return;

              // If nothing is speaking, start speaking
              if (!window.speechSynthesis.speaking && !currentUtterance) {
                currentUtterance = new SpeechSynthesisUtterance(text);
                // Optional: set voice/lang/rate/pitch
                currentUtterance.lang = "en-US";
                currentUtterance.rate = 1;

                currentUtterance.onend = () => {
                  currentUtterance = null;
                  resetNarrateButton();
                };

                currentUtterance.onerror = () => {
                  currentUtterance = null;
                  resetNarrateButton();
                };

                window.speechSynthesis.speak(currentUtterance);
                narrateBtn.innerText = "Pause";
                return;
              }

              // If speaking and not paused -> pause
              if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
                window.speechSynthesis.pause();
                narrateBtn.innerText = "Resume";
                return;
              }

              // If paused -> resume
              if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
                narrateBtn.innerText = "Pause";
                return;
              }

              // Fallback: if something weird, cancel and reset
              window.speechSynthesis.cancel();
              currentUtterance = null;
              resetNarrateButton();
            });

            // Cancel speech when popup unloads or new summary generated
            const cleanupNarration = () => {
              if (window.speechSynthesis.speaking || window.speechSynthesis.paused) {
                window.speechSynthesis.cancel();
              }
              currentUtterance = null;
            };

            window.addEventListener("beforeunload", cleanupNarration);

            resultDiv.appendChild(narrateBtn);
          } catch (error) {
            resultDiv.innerText = `Error: ${
              error.message || "Failed to generate summary."
            }`;
          }
        }
      );
    });
  });
});

document.getElementById("copy-btn").addEventListener("click", () => {
  const summaryText = document.getElementById("result").innerText;

  if (summaryText && summaryText.trim() !== "") {
    navigator.clipboard
      .writeText(summaryText)
      .then(() => {
        const copyBtn = document.getElementById("copy-btn");
        const originalText = copyBtn.innerText;

        copyBtn.innerText = "Copied!";
        setTimeout(() => {
          copyBtn.innerText = originalText;
        }, 2000);
      })
      .catch((err) => {
        console.error("Failed to copy text: ", err);
      });
  }
});

async function getGeminiSummary(text, summaryType, apiKey) {
  // Truncate very long texts to avoid API limits (typically around 30K tokens)
  const maxLength = 20000;
  const truncatedText =
    text.length > maxLength ? text.substring(0, maxLength) + "..." : text;

  let prompt;
  switch (summaryType) {
    case "brief":
      prompt = `Provide a brief summary of the following article in 2-3 sentences:\n\n${truncatedText}`;
      break;
    case "detailed":
      prompt = `Provide a detailed summary of the following article, covering all main points and key details:\n\n${truncatedText}`;
      break;
    case "bullets":
      prompt = `Summarize the following article in 5-7 key points. Format each point as a line starting with "- " (dash followed by a space). Do not use asterisks or other bullet symbols, only use the dash. Keep each point concise and focused on a single key insight from the article:\n\n${truncatedText}`;
      break;
    default:
      prompt = `Summarize the following article:\n\n${truncatedText}`;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      }
    );

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error?.message || "API request failed");
    }

    const data = await res.json();
    return (
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No summary available."
    );
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw new Error("Failed to generate summary. Please try again later.");
  }
}
