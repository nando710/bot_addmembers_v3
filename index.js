require('dotenv').config();
const express = require('express');
const axios = require('axios');
const winston = require('winston');
const moment = require('moment');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, EmbedBuilder, ComponentType } = require('discord.js');

// --- INICIALIZAÇÕES ---
const app = express();
const port = process.env.PORT || 3000;

// Permite JSON
app.use(express.json());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, 
    ]
});

// --- VARIÁVEIS DE AMBIENTE ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const REDIRECT_URI = process.env.REDIRECT_URI; 
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// Variáveis dos Cargos e Tickets
const CATEGORY_ID = process.env.CATEGORY_ID;         
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID; 
const ROLE_ID = process.env.ROLE_ID;                // Cargo Membro
const CLIENT_ROLE_ID = process.env.CLIENT_ROLE_ID;  // Cargo VIP
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // <--- NOVO: ID do canal de Logs

// Webhooks (n8n)
const WEBHOOK_AUTH_URL = process.env.MEU_WEBHOOK_URL;       
const WEBHOOK_VALIDACAO_URL = process.env.WEBHOOK_VALIDACAO_URL;

// =================================================================
//  SISTEMA DE LOGS (WINSTON + DISCORD)
// =================================================================

// Configuração do Winston (Logs em Arquivo e Console)
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'DD/MM/YYYY HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }), // Apenas erros
        new winston.transports.File({ filename: 'combined.log' }) // Tudo
    ],
});

// Função auxiliar para enviar logs para o canal do Discord
async function discordLog(titulo, descricao, cor = '#5865F2', fields = []) {
    if (!LOG_CHANNEL_ID) return; // Se não tiver canal configurado, ignora
    if (!client.isReady()) return;

    try {
        const canalLogs = client.channels.cache.get(LOG_CHANNEL_ID);
        if (!canalLogs) return logger.warn(`Canal de logs (${LOG_CHANNEL_ID}) não encontrado.`);

        const embed = new EmbedBuilder()
            .setTitle(titulo)
            .setDescription(descricao.substring(0, 4000)) // Limite do Discord
            .setColor(cor)
            .setTimestamp()
            .setFooter({ text: 'Sistema de Monitoramento' });

        if (fields.length > 0) embed.addFields(fields);

        await canalLogs.send({ embeds: [embed] });
    } catch (error) {
        logger.error(`Falha ao enviar log para o Discord: ${error.message}`);
    }
}

// Middleware para logar todas as requisições HTTP
app.use((req, res, next) => {
    logger.info(`HTTP Request: ${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

// =================================================================
//  PARTE 1: SERVIDOR WEB 
// =================================================================

app.get('/', (req, res) => {
    res.status(200).send('Bot Unificado Rodando 🚀');
});

// WEBHOOK DE BANIMENTO (Refund/Chargeback)
app.post('/webhook/ban', async (req, res) => {
    const { secret, discord_id, reason } = req.body;

    logger.info(`Tentativa de BAN recebida via Webhook. ID: ${discord_id}`);

    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
        logger.warn(`Tentativa de Ban não autorizada. Secret incorreto. IP: ${req.ip}`);
        discordLog('🚨 Tentativa de Invasão', `Tentativa de acesso ao endpoint /webhook/ban com secret incorreto.\n**IP:** ${req.ip}`, '#FF0000');
        return res.status(403).json({ error: "Acesso Negado: Secret incorreto." });
    }

    if (!discord_id) return res.status(400).json({ error: "Faltando discord_id." });

    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) throw new Error("Guild não encontrada no cache do Bot.");

        // Tenta buscar o usuário antes de banir para pegar info (opcional)
        let userTag = discord_id;
        try { const u = await client.users.fetch(discord_id); userTag = u.tag; } catch(e){}

        await guild.members.ban(discord_id, { reason: reason || 'Banimento automático (Refund)' });
        
        const msgSucesso = `🚫 USUÁRIO BANIDO: ${userTag} (${discord_id}) | Motivo: ${reason}`;
        logger.info(msgSucesso);
        discordLog('🔨 Banimento Automático', `**Usuário:** ${userTag}\n**ID:** ${discord_id}\n**Motivo:** ${reason}`, '#000000');

        return res.json({ success: true, message: `Banido com sucesso.` });
    } catch (error) {
        logger.error(`Erro ao banir usuário ${discord_id}: ${error.message}`);
        discordLog('❌ Erro no Banimento', `Falha ao banir ID ${discord_id}.\n**Erro:** ${error.message}`, '#FF0000');
        return res.status(500).json({ error: "Erro ao banir.", details: error.message });
    }
});

// ROTAS DE LOGIN
app.get('/login', (req, res) => {
    const emailDaCompra = req.query.email; 
    if (!CLIENT_ID || !REDIRECT_URI) {
        logger.error('Tentativa de login falhou: .env incompleto (CLIENT_ID ou REDIRECT_URI).');
        return res.status(500).send('Erro interno de configuração.');
    }

    const stateData = emailDaCompra ? encodeURIComponent(emailDaCompra) : '';
    const scopes = 'identify guilds.join email';
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${stateData}`;
    res.redirect(url);
});

app.get('/callback', async (req, res) => {
    const { code, state } = req.query; 
    
    if (!code) {
        logger.warn('Callback chamado sem código.');
        return res.send('Erro: Sem código do Discord.');
    }

    const emailCompraRecuperado = state ? decodeURIComponent(state) : "Não informado";

    try {
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
        });

        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const { access_token } = tokenResponse.data;

        const userResponse = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
        const userData = userResponse.data;

        logger.info(`Login efetuado: ${userData.username} (${userData.id}) - Email Compra: ${emailCompraRecuperado}`);
        
        // Log no Discord de novo login
        discordLog('🔐 Novo Login no Site', `**Usuário:** ${userData.username}\n**ID:** ${userData.id}\n**Email Discord:** ${userData.email}\n**Email Compra:** ${emailCompraRecuperado}`, '#00FF00');

        // Entrar no Servidor + Cargo Membro
        if (GUILD_ID) {
            try {
                await axios.put(
                    `https://discord.com/api/guilds/${GUILD_ID}/members/${userData.id}`,
                    { access_token: access_token }, 
                    { headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
                );
                logger.info(`Usuário ${userData.username} adicionado à Guilda.`);
            } catch (joinError) {
                logger.warn(`Não foi possível adicionar ${userData.username} à guilda (talvez já esteja lá): ${joinError.message}`);
            }

            if (ROLE_ID) {
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(userData.id).catch(() => null);
                        if (member) {
                            // Só adiciona se não tiver o VIP ainda, ou se for lógica de entrada padrão
                            await member.roles.add(ROLE_ID);
                            logger.info(`Cargo inicial adicionado para ${userData.username}`);
                        }
                    }
                } catch (roleError) { 
                    logger.error(`Erro ao dar cargo inicial para ${userData.username}: ${roleError.message}`);
                }
            }
        }

        // Webhook n8n
        if (WEBHOOK_AUTH_URL) {
            axios.post(WEBHOOK_AUTH_URL, {
                tipo: "LOGIN_SITE",
                email_compra: emailCompraRecuperado,
                discord_id: userData.id,
                username: userData.username,
                email_discord: userData.email,
                data: new Date().toISOString()
            }).catch(e => logger.error(`Erro ao enviar webhook auth n8n: ${e.message}`));
        }

        // --- TELA DE SUCESSO ---
        const discordRedirectUrl = `https://discord.com/channels/${GUILD_ID}`;
        
        res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Sucesso!</title>
                <style>
                    body { background-color: #2c2f33; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .box { background: #23272a; padding: 40px; border-radius: 10px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.3); max-width: 90%; }
                    h1 { color: #5865F2; margin-bottom: 10px; }
                    p { color: #b9bbbe; margin-bottom: 20px; }
                    .btn { background: #5865F2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; margin-top: 10px; transition: background 0.2s; }
                    .btn:hover { background: #4752c4; }
                    .loader { border: 4px solid #f3f3f3; border-top: 4px solid #5865F2; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 15px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="box">
                    <h1>Tudo certo! 🎉</h1>
                    <p>Sua conta foi vinculada com sucesso.</p>
                    <div class="loader"></div>
                    <p style="font-size: 14px;">Levando você para o Discord...</p>
                    <a href="${discordRedirectUrl}" class="btn">Abrir Discord Agora</a>
                </div>
                <script>
                    setTimeout(function() { window.location.href = "${discordRedirectUrl}"; }, 3000);
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        logger.error(`Erro Callback OAuth: ${error.message}`);
        if(error.response) logger.error(`Detalhes OAuth: ${JSON.stringify(error.response.data)}`);
        
        discordLog('❌ Erro no Login', `Erro ao processar callback de login.\n**Erro:** ${error.message}`, '#FF0000');
        res.status(500).send('Erro na autenticação. Tente novamente.');
    }
});

app.listen(port, () => {
    logger.info(`🌍 Servidor Web rodando na porta ${port}`);
});


// =================================================================
//  PARTE 2: CLIENTE DISCORD 
// =================================================================

client.on('ready', async () => {
    logger.info(`🤖 Bot Discord Logado: ${client.user.tag}`);
    discordLog('🟢 Bot Iniciado', `O sistema foi reiniciado e está online.\n**Log Channel:** <#${LOG_CHANNEL_ID}>`, '#00FF00');
    
    if (TICKET_CHANNEL_ID) {
        const canalTickets = client.channels.cache.get(TICKET_CHANNEL_ID);
        if (canalTickets) {
            try {
                const ultimasMensagens = await canalTickets.messages.fetch({ limit: 1 });
                const ultimaMsg = ultimasMensagens.first();
                
                if (!ultimaMsg || ultimaMsg.author.id !== client.user.id) {
                    const embed = new EmbedBuilder().setColor('#0099ff').setTitle('Validação de Acesso VIP').setDescription('Clique abaixo para validar sua compra.');
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('abrir_ticket').setLabel('Validar Compra').setEmoji('💎').setStyle(ButtonStyle.Success));
                    await canalTickets.send({ embeds: [embed], components: [row] });
                    logger.info('Painel de tickets postado/atualizado.');
                }
            } catch (e) { logger.error(`Erro ao postar painel tickets: ${e.message}`); }
        } else {
            logger.warn('Canal de Tickets não encontrado (TICKET_CHANNEL_ID inválido).');
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'abrir_ticket') {
        const nomeCanal = `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const jaTemTicket = interaction.guild.channels.cache.find(c => c.name === nomeCanal);
        if (jaTemTicket) return interaction.reply({ content: `⚠️ Você já tem um ticket: ${jaTemTicket}`, ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            const canal = await interaction.guild.channels.create({
                name: nomeCanal,
                type: ChannelType.GuildText,
                parent: CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: SUPPORT_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                ]
            });

            await interaction.editReply({ content: `✅ Ticket criado: ${canal}` });
            const embed = new EmbedBuilder().setTitle(`Olá, ${interaction.user.username}`).setDescription('**Digite o E-MAIL usado na compra:**').setColor('#f1c40f');
            const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('fechar_ticket').setLabel('Fechar').setStyle(ButtonStyle.Danger));
            await canal.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [btn] });
            
            logger.info(`Ticket criado: ${nomeCanal} por ${interaction.user.tag}`);
            iniciarColetaDeEmail(canal, interaction.user);

        } catch (error) {
            logger.error(`Erro ao criar ticket: ${error.message}`);
            discordLog('⚠️ Erro Ticket', `Falha ao criar ticket para ${interaction.user.tag}.\n**Erro:** ${error.message}`, '#FFA500');
            await interaction.editReply('❌ Erro ao criar ticket. Contate o suporte.');
        }
    }

    if (interaction.customId === 'fechar_ticket') {
        await interaction.reply('Encerrando...');
        logger.info(`Ticket fechado por ${interaction.user.tag}`);
        setTimeout(() => interaction.channel?.delete().catch(() => {}), 3000);
    }
});

function iniciarColetaDeEmail(canal, usuario) {
    const filter = m => m.author.id === usuario.id;
    const collector = canal.createMessageCollector({ filter, max: 1 });

    collector.on('collect', async (msg) => {
        const email = msg.content.trim();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sim').setLabel('Confirmar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('nao').setLabel('Corrigir').setStyle(ButtonStyle.Secondary)
        );

        const msgConf = await canal.send({ content: `E-mail: **${email}**. Confirma?`, components: [row] });
        const btnCol = msgConf.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        btnCol.on('collect', async (i) => {
            if (i.user.id !== usuario.id) return;
            if (i.customId === 'sim') {
                await i.update({ content: `🔄 Validando **${email}**...`, components: [] });
                
                try {
                    logger.info(`Validando email ${email} para usuário ${usuario.tag}`);
                    const resp = await axios.post(WEBHOOK_VALIDACAO_URL, { tipo: "VALIDACAO_TICKET", email: email, discord_id: usuario.id, username: usuario.username });
                    
                    const texto = resp.data.reply || "Processado.";
                    const aprovado = resp.data.approved === true;
                    
                    await canal.send({ embeds: [new EmbedBuilder().setDescription(texto).setColor(aprovado ? '#00FF00' : '#FF0000')] });
                    
                    if (aprovado) {
                        logger.info(`Validação APROVADA: ${email} - ${usuario.tag}`);
                        discordLog('💎 VIP Entregue', `**User:** ${usuario.tag}\n**Email:** ${email}`, '#00FFFF');

                        if (CLIENT_ROLE_ID) {
                            try {
                                const member = await canal.guild.members.fetch(usuario.id);
                                await member.roles.add(CLIENT_ROLE_ID);
                                await canal.send(`🎉 Cargo <@&${CLIENT_ROLE_ID}> entregue!`);

                                // --- REMOVE O CARGO COMUM SE EXISTIR ---
                                if (ROLE_ID) {
                                    try {
                                        if (member.roles.cache.has(ROLE_ID)) {
                                            await member.roles.remove(ROLE_ID);
                                            logger.info(`Cargo comum (Membro) removido de ${usuario.tag} após virar VIP.`);
                                        }
                                    } catch (removeError) {
                                        logger.error(`Erro ao remover cargo comum de ${usuario.tag}: ${removeError.message}`);
                                    }
                                }

                            } catch (e) { 
                                logger.error(`Erro ao dar cargo VIP: ${e.message}`);
                                await canal.send(`⚠️ Erro ao entregar cargo automático.`);
                            }
                        }
                    } else {
                        logger.warn(`Validação RECUSADA: ${email} - ${usuario.tag}`);
                    }

                } catch (e) { 
                    logger.error(`Erro API Validação (n8n): ${e.message}`);
                    await canal.send('❌ Erro de comunicação com o servidor de validação.');
                }
                btnCol.stop();
            } else {
                await i.update({ content: '⚠️ Digite o e-mail novamente:', components: [] });
                iniciarColetaDeEmail(canal, usuario);
                btnCol.stop();
            }
        });
    });
}

// =================================================================
//  ANTI-CRASH (Evita que o bot caia por erros bobos)
// =================================================================

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    discordLog('☠️ Unhandled Rejection', `\`\`\`js\n${reason}\n\`\`\``, '#FF0000');
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    discordLog('☠️ Uncaught Exception', `\`\`\`js\n${error.stack}\n\`\`\``, '#FF0000');
});

client.login(BOT_TOKEN);
