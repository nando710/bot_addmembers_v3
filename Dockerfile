# Usa uma imagem leve do Node.js
FROM node:18-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala as dependências
RUN npm install --production

# Copia o restante do código do bot
COPY . .

# Cria a pasta de logs para garantir permissões (importante para o winston)
RUN mkdir -p logs && chown -R node:node logs

# Define o usuário node por segurança (não rodar como root)
USER node

# Expõe a porta que o Express usa
EXPOSE 3000

# Comando para iniciar o bot
CMD ["npm", "start"]