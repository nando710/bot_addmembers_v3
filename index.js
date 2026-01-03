require('dotenv').config();
const fs = require('fs'); // Módulo nativo para gerenciar arquivos
const express = require('express');
const axios = require('axios');
const winston = require('winston');
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType, 
    PermissionsBitField, 
    EmbedBuilder, 
    ComponentType,
    Colors
} = require('discord.js');

// =================================================================
//  CONFIGURAÇÃO DE LOGS (WINSTON)
// =================================================================

// Lista inicial de onde os logs vão sair (pelo menos no Console)
const logTransports = [
    new winston.transports.Console()
];

// Tenta configurar logs em arquivo com tratamento de erro para evitar CRASH na VPS
try {
    // Garante que a pasta de logs existe antes de iniciar
    if (!fs.existsSync('logs')) {
        fs.mkdirSync('logs');
    }
    
    // Se chegou aqui, a pasta existe ou foi criada com sucesso, então adiciona os arquivos
    logTransports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
    logTransports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
} catch (error) {
    // Se der erro de permissão (comum no Coolify/Docker), avisa mas NÃO derruba o bot
    console.error('⚠️ ALERTA DE SISTEMA: Não foi possível criar/acessar a pasta "logs".');
    console.error(`📝 Motivo: ${error.message}`);
    console.log('✅ O bot continuará rodando, mas os logs ficarão apenas neste Console (Memory Only).');
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'DD/MM/YYYY HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: logTransports,
});

// =================================================================
//  INICIALIZAÇÃO DO CLIENTE DISCORD
// =================================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, 
    ]
});

// Variáveis de Ambiente
const {
    PORT = 3000,
    CLIENT_ID,
    CLIENT_SECRET,
    BOT_TOKEN,
    GUILD_ID,
    REDIRECT_URI,
    ADMIN_SECRET, // Senha para proteger seus webhooks
    CATEGORY_TICKET_ID,
    ROLE_MEMBER_ID, // Cargo dado no Login Web
    ROLE_CLIENT_ID, // Cargo dado após validar Ticket/N8N
    ROLE_SUPPORT_ID,
    CHANNEL_TICKET_ID,
    CHANNEL_LOG_ID,
    N8N_WEBHOOK_AUTH, // URL do N8N para reportar login
    N8N_WEBHOOK_VALIDATE // URL do N8N para validar ticket
} = process.env;

// =================================================================
//  FUNÇÕES AUXILIARES
// =================================================================

// Envia logs para um canal do Discord
async function discordLog(title, description, color = Colors.Blue) {
    if (!CHANNEL_LOG_ID) return;
    try {
        const channel = client.channels.cache.get(CHANNEL_LOG_ID);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description.substring(0, 4000))
            .setColor(color)
            .setTimestamp()
            .setFooter({ text: 'Sistema de Logs' });

        await channel.send({ embeds: [embed] });
    } catch (error) {
        logger.error(`Falha ao enviar log para o Discord: ${error.message}`);
    }
}

// =================================================================
//  SERVIDOR EXPRESS (WEB)
// =================================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rota Base
app.get('/', (req, res) => res.send('Bot Online 🟢'));

// 1. Rota de Login (Redireciona para o Discord)
app.get('/login', (req, res) => {
    // Scopes necessários: identify (perfil), guilds.join (adicionar ao server), email
    const scopes = 'identify guilds.join email';
    
    // Tratamento de erro: Limpa espaços em branco que podem vir do .env
    const cleanRedirectUri = REDIRECT_URI ? REDIRECT_URI.trim() : '';
    const cleanClientId = CLIENT_ID ? CLIENT_ID.trim() : '';

    if (!cleanRedirectUri || !cleanClientId) {
        logger.error('CONFIGURAÇÃO INVÁLIDA: CLIENT_ID ou REDIRECT_URI faltando no .env');
        return res.status(500).send('Erro no Servidor: Configuração OAuth incompleta.');
    }

    logger.info(`Iniciando Login. Usando Redirect URI: ${cleanRedirectUri}`);

    const url = `https://discord.com/api/oauth2/authorize?client_id=${cleanClientId}&redirect_uri=${encodeURIComponent(cleanRedirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
    res.redirect(url);
});

// 2. Callback do Login (Processa o retorno do Discord)
app.get('/callback', async (req, res) => {
    const { code } = req.query;

    if (!code) return res.status(400).send('Código de autorização não fornecido.');

    // Limpeza de variáveis para evitar erros de espaço
    const cleanRedirectUri = REDIRECT_URI ? REDIRECT_URI.trim() : '';
    const cleanClientId = CLIENT_ID ? CLIENT_ID.trim() : '';
    const cleanClientSecret = CLIENT_SECRET ? CLIENT_SECRET.trim() : '';

    try {
        // Troca o código pelo token de acesso
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: cleanClientId,
                client_secret: cleanClientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: cleanRedirectUri,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenResponse.data;

        // Pega dados do usuário
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });
        const userData = userResponse.data;

        logger.info(`Novo Login Web: ${userData.username} (${userData.id})`);

        // --- LÓGICA DE JOIN E CARGO APRIMORADA ---
        
        // 1. Prepara o payload do Join. Se tiver ROLE_MEMBER_ID, tenta dar direto no Join.
        const joinBody = { access_token };
        if (ROLE_MEMBER_ID) {
            joinBody.roles = [ROLE_MEMBER_ID];
        }

        try {
            await axios.put(
                `https://discord.com/api/guilds/${GUILD_ID}/members/${userData.id}`,
                joinBody,
                { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
            );
        } catch (err) {
            // Ignora erro 204 (usuário já existe), loga outros
            if (err.response && err.response.status !== 204) {
                logger.warn(`API Join Warning: ${err.message}`);
            }
        }

        // 2. Fallback Seguro: Garante o cargo mesmo se o usuário já estava no servidor
        // Tenta pegar a guild do cache ou fetch se não tiver
        const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID).catch(() => null);

        if (guild && ROLE_MEMBER_ID) {
            try {
                // Tenta buscar o membro. O fetch força verificar na API do Discord
                let member = await guild.members.fetch(userData.id).catch(() => null);
                
                // Se não achou de primeira, espera 1 segundo (tempo de propagação) e tenta de novo
                if (!member) {
                    await new Promise(r => setTimeout(r, 1000));
                    member = await guild.members.fetch(userData.id).catch(() => null);
                }

                if (member) {
                    // Só tenta adicionar se ele AINDA NÃO tiver o cargo
                    if (!member.roles.cache.has(ROLE_MEMBER_ID)) {
                        await member.roles.add(ROLE_MEMBER_ID);
                        logger.info(`Cargo MEMBRO COMUM adicionado para ${userData.username} (via fallback).`);
                    }
                } else {
                    logger.warn(`ALERTA: Usuário ${userData.username} autenticou mas não foi encontrado no servidor para dar cargo.`);
                }
            } catch (roleError) {
                logger.error(`Erro ao processar cargo de membro: ${roleError.message}`);
            }
        }

        // Notifica N8N sobre o login
        if (N8N_WEBHOOK_AUTH) {
            axios.post(N8N_WEBHOOK_AUTH, {
                event: 'web_login',
                discord_id: userData.id,
                username: userData.username,
                email: userData.email,
                timestamp: new Date().toISOString()
            }).catch(() => null);
        }

        // Página de Sucesso Bonita
        res.send(`
            <html>
                <body style="background:#2c2f33;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;">
                    <div style="text-align:center;background:#23272a;padding:40px;border-radius:10px;">
                        <h1 style="color:#5865F2">Sucesso! 🚀</h1>
                        <p>Você foi autenticado e adicionado ao servidor.</p>
                        <p>Pode fechar esta janela.</p>
                    </div>
                </body>
            </html>
        `);

        discordLog('🔐 Login Web Efetuado', `Usuário: **${userData.username}**\nID: \`${userData.id}\`\nEmail: ||${userData.email}||`, Colors.Green);

    } catch (error) {
        logger.error(`Erro no Callback OAuth: ${error.message}`);
        if (error.response) {
            logger.error(`Discord API Error: ${JSON.stringify(error.response.data)}`);
        }
        res.status(500).send('Erro na autenticação. Verifique os logs do servidor.');
    }
});

// 3. Webhook de Gestão (Recebe do N8N para Banir ou Remover Cargo)
app.post('/webhook/manage-user', async (req, res) => {
    const { secret, action, discord_id, reason } = req.body;

    // Segurança Básica
    if (secret !== ADMIN_SECRET) {
        logger.warn(`Tentativa de acesso não autorizado ao webhook por ${req.ip}`);
        return res.status(403).json({ error: 'Acesso negado (Token inválido)' });
    }

    if (!discord_id || !action) {
        return res.status(400).json({ error: 'Dados incompletos (discord_id e action são obrigatórios)' });
    }

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return res.status(500).json({ error: 'Bot não está no servidor configurado.' });

    try {
        const member = await guild.members.fetch(discord_id).catch(() => null);

        if (action === 'ban') {
            await guild.members.ban(discord_id, { reason: reason || 'Banimento via Webhook (Sistema)' });
            discordLog('🔨 Usuário Banido', `ID: ${discord_id}\nMotivo: ${reason}`, Colors.Red);
            return res.json({ success: true, message: 'Usuário banido.' });
        }

        if (action === 'remove_vip') {
            if (member && ROLE_CLIENT_ID) {
                await member.roles.remove(ROLE_CLIENT_ID, reason);
                discordLog('📉 VIP Removido', `Usuário: ${member.user.tag}\nMotivo: ${reason}`, Colors.Orange);
                return res.json({ success: true, message: 'Cargo removido.' });
            } else {
                return res.status(404).json({ error: 'Membro não encontrado ou cargo não configurado.' });
            }
        }

        return res.status(400).json({ error: 'Ação desconhecida.' });

    } catch (error) {
        logger.error(`Erro no Webhook Manage: ${error.message}`);
        return res.status(500).json({ error: error.message });
    }
});

// Inicia Servidor Web
app.listen(PORT, () => logger.info(`🌍 Servidor Web rodando na porta ${PORT}`));


// =================================================================
//  LÓGICA DO BOT DISCORD
// =================================================================

client.on('ready', async () => {
    logger.info(`🤖 Bot logado como ${client.user.tag}`);
    
    // Configura/Verifica Painel de Tickets
    if (CHANNEL_TICKET_ID) {
        const channel = client.channels.cache.get(CHANNEL_TICKET_ID);
        if (channel) {
            // Busca mensagens antigas para não duplicar o painel
            const messages = await channel.messages.fetch({ limit: 5 });
            const hasPanel = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);

            if (!hasPanel) {
                const embed = new EmbedBuilder()
                    .setTitle('Validação de Cliente')
                    .setDescription('Para liberar seu acesso VIP, clique no botão abaixo e informe o e-mail da compra.')
                    .setColor(Colors.Gold)
                    .setFooter({ text: 'Suporte Automatizado' });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('open_ticket')
                        .setLabel('Validar Compra')
                        .setEmoji('💎')
                        .setStyle(ButtonStyle.Success)
                );

                await channel.send({ embeds: [embed], components: [row] });
                logger.info('Painel de tickets criado.');
            }
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // --- ABRIR TICKET ---
    if (interaction.customId === 'open_ticket') {
        const channelName = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 25);
        
        // Verifica se já existe
        const existingChannel = interaction.guild.channels.cache.find(c => c.name === channelName && c.parentId === CATEGORY_TICKET_ID);
        if (existingChannel) {
            return interaction.reply({ content: `Você já possui um ticket aberto: ${existingChannel}`, ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const ticketChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: CATEGORY_TICKET_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: ROLE_SUPPORT_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                ]
            });

            await interaction.editReply({ content: `✅ Ticket criado: ${ticketChannel}` });

            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Olá, ${interaction.user.username}!`)
                .setDescription('Por favor, **digite o E-MAIL** utilizado na compra para liberarmos seu acesso.\n\nCaso queira cancelar, clique em fechar.')
                .setColor(Colors.Blue);

            const closeBtn = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Fechar Ticket').setStyle(ButtonStyle.Danger)
            );

            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed], components: [closeBtn] });

            // Inicia o coletor de e-mail
            handleTicketEmailCollection(ticketChannel, interaction.user);

        } catch (error) {
            logger.error(`Erro ao criar ticket: ${error.message}`);
            interaction.editReply('Erro ao criar o ticket. Avise um administrador.');
        }
    }

    // --- FECHAR TICKET ---
    if (interaction.customId === 'close_ticket') {
        if (!interaction.channel.name.startsWith('ticket-')) return;
        await interaction.reply('Fechando ticket em 5 segundos...');
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
});

// Função para Coletar E-mail dentro do Ticket
function handleTicketEmailCollection(channel, user) {
    const filter = m => m.author.id === user.id && !m.author.bot;
    const collector = channel.createMessageCollector({ filter, time: 300000 }); // 5 minutos

    collector.on('collect', async (message) => {
        const email = message.content.trim();
        
        // Validação simples de regex de email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return channel.send('⚠️ Formato de e-mail inválido. Tente novamente.');
        }

        // Pausa o coletor para confirmação
        // collector.stop('confirmation'); 

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`confirm_yes_${email}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('confirm_no').setLabel('Cancelar/Corrigir').setStyle(ButtonStyle.Secondary)
        );

        const msgConfirm = await channel.send({ 
            content: `Você digitou: **${email}**. Está correto?`, 
            components: [confirmRow] 
        });

        // Coletor para os botões de confirmação
        const btnCollector = msgConfirm.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        btnCollector.on('collect', async (i) => {
            if (i.user.id !== user.id) return;

            if (i.customId === 'confirm_no') {
                await i.update({ content: 'Ok, digite o e-mail novamente abaixo.', components: [] });
                return; // O message collector principal continua rodando
            }

            if (i.customId.startsWith('confirm_yes_')) {
                await i.update({ content: `🔄 Verificando **${email}** no sistema... Aguarde.`, components: [] });
                collector.stop(); // Para de ouvir novas mensagens

                // --- CHAMADA AO N8N ---
                if (!N8N_WEBHOOK_VALIDATE) {
                    return channel.send('❌ Erro: Webhook de validação não configurado no .env.');
                }

                try {
                    const response = await axios.post(N8N_WEBHOOK_VALIDATE, {
                        email: email,
                        discord_id: user.id,
                        username: user.username,
                        ticket_channel: channel.id
                    });

                    // Espera que o N8N retorne { approved: true, message: "..." }
                    const { approved, message } = response.data;

                    if (approved) {
                        const member = await channel.guild.members.fetch(user.id);
                        
                        // Adiciona o Cargo VIP
                        if (ROLE_CLIENT_ID) await member.roles.add(ROLE_CLIENT_ID);
                        
                        // Remove o Cargo Comum (Se estiver configurado e o usuário tiver)
                        if (ROLE_MEMBER_ID) {
                            await member.roles.remove(ROLE_MEMBER_ID).catch(e => logger.warn(`Erro ao remover cargo comum: ${e.message}`));
                        }
                        
                        const successEmbed = new EmbedBuilder()
                            .setTitle('✅ Acesso Liberado!')
                            .setDescription(message || 'Sua compra foi validada e seu cargo foi entregue.')
                            .setColor(Colors.Green);
                        
                        await channel.send({ embeds: [successEmbed] });
                        discordLog('💎 Ticket Validado', `User: ${user.tag}\nEmail: ${email}`, Colors.Green);
                        
                        // Opcional: Fechar ticket automaticamente após sucesso
                        setTimeout(() => channel.send('Este ticket será fechado em 10 segundos...'), 2000);
                        setTimeout(() => channel.delete().catch(()=>{}), 12000);

                    } else {
                        await channel.send({ 
                            embeds: [new EmbedBuilder().setTitle('❌ Negado').setDescription(message || 'E-mail não encontrado ou compra reembolsada.').setColor(Colors.Red)] 
                        });
                        discordLog('🚫 Validação Falhou', `User: ${user.tag}\nEmail: ${email}\nMotivo: ${message}`, Colors.Red);
                    }

                } catch (err) {
                    logger.error(`Erro ao chamar N8N: ${err.message}`);
                    channel.send('❌ Erro de comunicação com o servidor. Tente mais tarde.');
                }
            }
        });
    });
}

// Anti-Crash Global
process.on('unhandledRejection', (reason, p) => {
    logger.error(`[Anti-Crash] Rejeição não tratada: ${reason}`);
});
process.on('uncaughtException', (err, origin) => {
    logger.error(`[Anti-Crash] Exceção não capturada: ${err}`);
});

client.login(BOT_TOKEN);
