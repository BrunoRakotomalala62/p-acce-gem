const axios = require('axios');
const sendMessage = require('../handles/sendMessage'); // Importer la fonction sendMessage

// Objet pour stocker les questions et les réponses pour chaque utilisateur
const userQuizzes = {};

// Open Trivia Database limite à ~1 requête / 5 secondes par IP.
// On garde la date du dernier appel pour ne pas se faire rate-limiter (HTTP 429).
let lastOpentdbCall = 0;
const OPENTDB_MIN_INTERVAL_MS = 5500;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Décoder les entités HTML renvoyées par opentdb (&quot;, &#039;, &amp;, ...)
function decodeHtmlEntities(text) {
    if (!text) return text;
    const named = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&apos;': "'", '&#039;': "'", '&nbsp;': ' ', '&ndash;': '–',
        '&mdash;': '—', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘',
    };
    let decoded = text.replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|rsquo|lsquo|#039);/gi, (m) => named[m.toLowerCase()] || m);
    decoded = decoded.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
    return decoded;
}

// Récupérer une question de quiz : opentdb d'abord (avec backoff), API de secours sinon.
async function fetchQuizQuestion() {
    // Source 1 : Open Trivia Database
    if (Date.now() - lastOpentdbCall >= OPENTDB_MIN_INTERVAL_MS) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            lastOpentdbCall = Date.now();
            try {
                const response = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple', {
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)' },
                });
                if (response.data && response.data.response_code === 0 && response.data.results && response.data.results[0]) {
                    const q = response.data.results[0];
                    return {
                        question: decodeHtmlEntities(q.question),
                        correctAnswer: decodeHtmlEntities(q.correct_answer),
                        incorrectAnswers: (q.incorrect_answers || []).map(decodeHtmlEntities),
                    };
                }
                // response_code === 5 : API rate-limitée -> on attend avant de réessayer
                console.error('opentdb rate-limité (response_code:', response.data.response_code, ')');
            } catch (error) {
                console.error('Erreur opentdb (tentative', attempt + 1, '):', error.message, error.response ? 'HTTP ' + error.response.status : '');
            }
            if (attempt < MAX_RETRIES) await sleep(3000 + attempt * 2000); // 3s puis 5s
        }
    }

    // Source 2 (secours) : The Trivia API — gratuite, sans clé, sans rate-limit agressif
    try {
        const response = await axios.get('https://the-trivia-api.com/v2/questions?limit=1', {
            timeout: REQUEST_TIMEOUT_MS,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuizBot/1.0)' },
        });
        const q = response.data && response.data[0];
        if (q && q.question && q.question.text) {
            return {
                question: q.question.text,
                correctAnswer: q.correctAnswer,
                incorrectAnswers: q.incorrectAnswers || [],
            };
        }
    } catch (error) {
        console.error('Erreur API de secours quiz:', error.message);
    }

    return null;
}

module.exports = async (senderId, prompt) => {
    try {
        const promptTrimmed = String(prompt || '').trim();

        // Réinitialisation du quiz si demandé (commande "supprimer" / "stop" du bot)
        if (promptTrimmed.toLowerCase() === 'reset_conversation' || promptTrimmed.toLowerCase() === 'stop') {
            delete userQuizzes[senderId];
            return;
        }

        // Vérifier si l'utilisateur a déjà un quiz en cours
        if (userQuizzes[senderId]) {
            const userAnswer = promptTrimmed;
            const correctAnswer = userQuizzes[senderId].correctAnswer;
            const shuffledAnswers = userQuizzes[senderId].shuffledAnswers;

            // Vérifier si l'utilisateur a entré un numéro valide
            const userAnswerIndex = parseInt(userAnswer, 10) - 1; // Convertir la réponse en index (1-based -> 0-based)

            if (!isNaN(userAnswerIndex) && shuffledAnswers[userAnswerIndex] === correctAnswer) {
                await sendMessage(senderId, "🎉 Réponse correcte !");
            } else if (!isNaN(userAnswerIndex) && shuffledAnswers[userAnswerIndex]) {
                await sendMessage(senderId, `❌ Réponse incorrecte. La bonne réponse est : ${correctAnswer}.`);
            } else {
                // Réponse non reconnue : on laisse le quiz en cours et on réaffiche la question
                await sendMessage(senderId, "Veuillez répondre avec le numéro de la bonne réponse (1, 2, 3 ou 4).");
                return;
            }

            // Relancer automatiquement une nouvelle question
            return await askNewQuestion(senderId);
        }

        // Démarrer un nouveau quiz
        return await askNewQuestion(senderId);
    } catch (error) {
        console.error('Erreur lors de l\'appel à l\'API de quiz:', error);

        // Envoyer un message d'erreur à l'utilisateur en cas de problème
        await sendMessage(senderId, "Désolé, une erreur s'est produite lors du traitement de votre message.");
    }
};

async function askNewQuestion(senderId) {
    const quizData = await fetchQuizQuestion();
    if (!quizData) {
        await sendMessage(senderId, "😕 Je n'arrive pas à récupérer une question de quiz pour le moment. Réessayez dans quelques secondes.");
        return;
    }

    const { question, correctAnswer, incorrectAnswers } = quizData;

    // Créer un tableau des réponses possibles et le mélanger
    const allAnswers = [correctAnswer, ...incorrectAnswers];
    const shuffledAnswers = allAnswers.sort(() => Math.random() - 0.5); // Mélanger les réponses

    // Traduire la question et les réponses avec MyMemory (repli sur le texte original en cas d'échec)
    const translatedQuestion = await translateTextWithLimit(question, 'en', 'fr');
    const translatedAnswers = await Promise.all(shuffledAnswers.map(answer => translateTextWithLimit(answer, 'en', 'fr')));
    const translatedCorrectAnswer = await translateTextWithLimit(correctAnswer, 'en', 'fr');

    // Stocker les données du quiz pour cet utilisateur
    userQuizzes[senderId] = {
        question: translatedQuestion,
        correctAnswer: translatedCorrectAnswer,
        shuffledAnswers: translatedAnswers,
    };

    // Formater la réponse à envoyer à l'utilisateur
    const formattedAnswers = translatedAnswers.map((answer, index) => `${index + 1}. ${answer}`).join('\n');

    // Attendre 1 seconde avant d'envoyer la réponse
    await sleep(1000);

    // Envoyer la question et les réponses mélangées à l'utilisateur
    await sendMessage(senderId, `Voici votre question de quiz :\n${translatedQuestion}\n\nChoisissez une réponse :\n${formattedAnswers}`);
}

// Fonction pour découper le texte en morceaux de 500 caractères maximum
function splitTextIntoChunks(text, maxLength = 500) {
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLength) {
        chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
}

// Fonction pour traduire du texte avec MyMemory, en découpant si nécessaire
async function translateTextWithLimit(text, fromLang, toLang) {
    const chunks = splitTextIntoChunks(text, 500); // Découper le texte en morceaux de 500 caractères maximum
    const translatedChunks = await Promise.all(chunks.map(async (chunk) => {
        try {
            const translateUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${fromLang}|${toLang}`;
            const response = await axios.get(translateUrl, { timeout: REQUEST_TIMEOUT_MS });
            const translated = response.data && response.data.responseData && response.data.responseData.translatedText;
            // Si le quota MyMemory est épuisé ou la réponse invalide, garder le texte original
            if (!translated || /MYMEMORY WARNING|QUOTA|LIMIT|INVALID/i.test(translated)) {
                return chunk;
            }
            return translated;
        } catch (error) {
            return chunk; // En cas d'erreur réseau, garder le texte original
        }
    }));
    return translatedChunks.join(' '); // Recombiner les morceaux traduits
}

// Ajouter les informations de la commande
module.exports.info = {
    name: "quiz",  // Le nom de la commande
    description: "Poser une question de quiz aléatoire et vérifier la réponse.",  // Description de la commande
    usage: "Envoyez 'quiz' pour commencer un quiz. Répondez en tapant le numéro de la réponse."  // Comment utiliser la commande
};
