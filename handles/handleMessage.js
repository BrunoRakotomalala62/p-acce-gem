const fs = require('fs-extra');
const path = require('path');
const sendMessage = require('./sendMessage');
const axios = require('axios');
const { checkSubscription } = require('../utils/subscription');
const geminiModule = require('../auto/gemini');

// Charger toutes les commandes du dossier 'commands'
const commandFiles = fs.readdirSync(path.join(__dirname, '../commands')).filter(file => file.endsWith('.js'));
const commands = {};

// 状态 de pagination global pour être accessible dans ce module
const userPaginationStates = {};

// Charger les commandes dans un objet
for (const file of commandFiles) {
    const commandName = file.replace('.js', '');
    commands[commandName] = require(`../commands/${file}`);

    // Si c'est la commande help, récupérer son état de pagination
    if (commandName === 'help' && commands[commandName].userPaginationStates) {
        Object.assign(userPaginationStates, commands[commandName].userPaginationStates);
    }
}

console.log('Les commandes suivantes ont été chargées :', Object.keys(commands));

const activeCommands = {};
const imageHistory = {};
const MAX_MESSAGE_LENGTH = 2000; // Limite de caractères pour chaque message envoyé

// Nouveau suivi des questions par image
const userImageQuestionCount = {};

// Stocker les utilisateurs à qui on a déjà envoyé une alerte d'expiration
const expirationAlertSent = {};

// Gestion des messages entrants
const handleMessage = async (event, api) => {
    const senderId = event.sender.id;
    const message = event.message;

    // Vérifier l'abonnement de l'utilisateur
    const subscription = checkSubscription(senderId);

    // Autoriser l'accès à UID ou à auto/gemini.js pour tous les utilisateurs
    // Pour les autres commandes, vérifier si l'utilisateur est abonné
    const isGeminiMessage = !message.text || !newCommandDetected; // Si ce n'est pas une commande ou pas de texte (image), sera traité par gemini
    const isCommandAllowed = message.text && (
        message.text.toLowerCase().startsWith('uid')
    );

    // Si l'utilisateur n'est pas abonné et que ce n'est pas une commande autorisée ni un message pour auto/gemini.js
    if (!subscription.isSubscribed && !isCommandAllowed && !isGeminiMessage) {
        await sendMessage(senderId, 
            "✨ *ACCÈS EXCLUSIF* ✨\n\n" +
            "🤖 Bonjour! Pour profiter de toutes les fonctionnalités de ce bot intelligent, un abonnement est nécessaire.\n\n" +
            "💰 *TARIF SPÉCIAL* : Seulement 2000 AR/mois!\n\n" +
            "💳 *MÉTHODES DE PAIEMENT* :\n" +
            "• MVola : 0346973333\n" +
            "• Airtel Money : 0338764195\n" +
            "• Contact direct : 0346973333\n\n" +
            "🔍 *COMMENT S'ABONNER* :\n" +
            "1️⃣ Effectuez votre paiement via MVola ou Airtel Money\n" +
            "2️⃣ Envoyez la capture d'écran de votre paiement à l'administrateur\n" +
            "3️⃣ Votre accès sera activé immédiatement!\n\n" +
            "👨‍💻 *ADMINISTRATEUR* : https://www.facebook.com/bruno.rakotomalala.7549\n\n" +
            "ℹ️ Tapez 'help' pour découvrir toutes les commandes disponibles!"
        );
        return;
    }

    // Si l'abonnement expire bientôt (moins de 3 jours) et qu'on n'a pas encore envoyé l'alerte
    if (subscription.isSubscribed && subscription.daysLeft <= 3 && !expirationAlertSent[senderId]) {
        await sendMessage(senderId, 
            `⚠️ Attention! Votre abonnement expire dans ${subscription.daysLeft} jour(s).\n` +
            "Pour renouveler, contactez le 0345788639 (2000 AR/mois)."
        );
        // Marquer que l'alerte a été envoyée à cet utilisateur
        expirationAlertSent[senderId] = true;
    }

    // Commande "stop" pour désactiver toutes les commandes persistantes
    if (message.text && message.text.toLowerCase() === 'stop') {
        const previousCommand = activeCommands[senderId];
        activeCommands[senderId] = null;
        const responseMessage = previousCommand 
            ? `La commande ${previousCommand} a été désactivée. Vous pouvez maintenant utiliser d'autres commandes ou discuter librement.`
            : "Vous n'aviez pas de commande active. Vous pouvez continuer à discuter librement.";
        await sendMessage(senderId, responseMessage);
        return;
    }
    
    // Commande "supprimer" pour réinitialiser la mémoire de la commande active sans la désactiver
    if (message.text && message.text.toLowerCase() === 'supprimer') {
        const activeCommand = activeCommands[senderId];
        
        if (activeCommand) {
            // Conserver la commande active mais réinitialiser son contexte
            try {
                // On peut notifier l'utilisateur que la conversation est réinitialisée
                await sendMessage(senderId, `🔄 Conversation avec la commande ${activeCommand} réinitialisée. Vous pouvez continuer avec un nouveau sujet.`);
                
                // Réinitialiser l'historique spécifique à la commande si la commande stocke son propre état
                // Note: Cette réinitialisation dépend de la commande, nous ne pouvons pas accéder directement 
                // à la mémoire interne de chaque commande, mais nous pouvons envoyer un signal
                
                // Envoyer un message spécial à la commande pour indiquer une réinitialisation
                await commands[activeCommand](senderId, "RESET_CONVERSATION", api);
            } catch (error) {
                console.error(`Erreur lors de la réinitialisation de la commande ${activeCommand}:`, error);
                await sendMessage(senderId, `Une erreur s'est produite lors de la réinitialisation de la commande ${activeCommand}.`);
            }
            return;
        } else {
            await sendMessage(senderId, "Vous n'avez pas de commande active à réinitialiser.");
            return;
        }
    }

    // Si des pièces jointes sont envoyées, gérer les images
    if (message.attachments && message.attachments.length > 0) {
        const imageAttachments = message.attachments.filter(attachment => attachment.type === 'image');

        if (imageAttachments.length > 0) {
            // Si une commande est active, elle gère les pièces jointes
            if (activeCommands[senderId]) {
                const activeCommand = activeCommands[senderId];
                try {
                    const result = await commands[activeCommand](senderId, "IMAGE_ATTACHMENT", api, imageAttachments);
                    if (result && result.skipCommandCheck) {
                        return;
                    }
                } catch (error) {
                    console.error(`Erreur lors de l'exécution de la commande ${activeCommand} avec une image:`, error);
                    await sendMessage(senderId, `Une erreur s'est produite lors de l'exécution de la commande ${activeCommand} avec votre image.`);
                }
                return;
            }

            // Si aucune commande active, utiliser auto/gemini.js pour les images
            for (const image of imageAttachments) {
                const imageUrl = image.payload.url;

                // Historique des images envoyées par l'utilisateur
                if (!imageHistory[senderId]) {
                    imageHistory[senderId] = [];
                }
                imageHistory[senderId].push(imageUrl);

                // Réinitialiser le compteur de questions pour cette image
                if (!userImageQuestionCount[senderId]) {
                    userImageQuestionCount[senderId] = {};
                }

                // Si c'est une nouvelle image, réinitialiser le compteur
                if (!userImageQuestionCount[senderId][imageUrl]) {
                    userImageQuestionCount[senderId][imageUrl] = 0;
                }

                // Vérifier si la limite de 30 questions a été atteinte
                if (userImageQuestionCount[senderId][imageUrl] >= 30) {
                    await sendMessage(senderId, "Vous avez atteint la limite de 30 questions pour cette image. Si vous avez une nouvelle image, envoyez-la et posez vos nouvelles questions.");
                    return;
                }

                // Incrémenter le compteur de questions pour cette image
                userImageQuestionCount[senderId][imageUrl]++;

                // Utiliser le module gemini pour traiter l'image
                await geminiModule.handleImageMessage(senderId, imageUrl);
            }
            return;
        } else {
            await sendMessage(senderId, "Aucune image n'a été trouvée dans le message.");
            return;
        }
    }

    // Vérifier si l'utilisateur a envoyé un message texte
    if (!message.text) {
        await sendMessage(senderId, "Je n'ai pas compris votre message. Veuillez envoyer du texte ou une image.");
        return;
    }

    // Texte de l'utilisateur
    const userText = message.text.trim();
    const userTextLower = userText.toLowerCase();

    // Vérifier d'abord si l'utilisateur est en mode pagination pour help
    if (userPaginationStates[senderId] && userPaginationStates[senderId].isActive) {
        // Passer le texte à la commande help pour la navigation
        await commands['help'](senderId, userText);
        return;
    }

    // Détecter si une nouvelle commande est utilisée
    let newCommandDetected = false;
    let detectedCommandName = null;

    for (const commandName in commands) {
        if (userTextLower.startsWith(commandName)) {
            newCommandDetected = true;
            detectedCommandName = commandName;
            break;
        }
    }

    // Vérifier si une nouvelle commande est détectée

    // Si une nouvelle commande est détectée, elle devient la commande active
    if (newCommandDetected) {
        activeCommands[senderId] = detectedCommandName;
        console.log(`Nouvelle commande active pour ${senderId}: ${detectedCommandName}`);
    }

    // Si une commande persistante est active pour cet utilisateur
    if (activeCommands[senderId] && activeCommands[senderId] !== 'help') {
        const activeCommand = activeCommands[senderId];
        console.log(`Commande persistante en cours pour ${senderId}: ${activeCommand}`);

        // Si une nouvelle commande est détectée, exécuter cette nouvelle commande
        const commandPrompt = newCommandDetected 
            ? userText.replace(detectedCommandName, '').trim()
            : userText;

        try {
            const result = await commands[activeCommand](senderId, commandPrompt, api);
            if (result && result.skipCommandCheck) {
                // Continuer le traitement
            } else {
                return; // Arrêter le traitement après l'exécution de la commande
            }
        } catch (error) {
            console.error(`Erreur lors de l'exécution de la commande ${activeCommand}:`, error);
            await sendMessage(senderId, `Une erreur s'est produite lors de l'exécution de la commande ${activeCommand}.`);
            return;
        }
    }
    // Si aucune commande active, vérifier si une commande est détectée dans le message
    else if (newCommandDetected) {
        const commandPrompt = userText.replace(detectedCommandName, '').trim();
        const commandFile = commands[detectedCommandName];

        // Vérifier si la commande existe et l'exécuter
        if (commandFile) {
            try {
                const result = await commandFile(senderId, commandPrompt, api);

                // Vérifier si la commande a demandé de sauter la vérification des autres commandes
                if (result && result.skipCommandCheck) {
                    // Continuer le traitement
                } else {
                    return; // Arrêter le traitement après l'exécution de la commande
                }
            } catch (error) {
                console.error(`Erreur lors de l'exécution de la commande ${detectedCommandName}:`, error);
                await sendMessage(senderId, `Une erreur s'est produite lors de l'exécution de la commande ${detectedCommandName}.`);
                return;
            }
        }
    }

    // Si aucune commande n'est active ou détectée, ALORS utiliser auto/gemini.js
    // Vérifier d'abord si une commande est déjà active
    if (!activeCommands[senderId]) {
        await geminiModule.handleTextMessage(senderId, userText);
    }
};

module.exports = handleMessage;