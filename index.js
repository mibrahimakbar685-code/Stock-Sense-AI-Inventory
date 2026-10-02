import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient, MovementType, MovementSource, ProposalStatus, Role } from '@prisma/client';
import { z } from 'zod';

const app = express();
const db = new PrismaClient();
const port = process.env.PORT || 4000;
const secret = process.env.JWT_SECRET || 'development-only-secret';
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

const cleanProduct = (product, role) => {
  const { costPrice, ...safe } = product;
  return role === Role.MANAGER ? product : safe;
};
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new Error('Missing token');
    const payload = jwt.verify(token, secret);
    req.user = await db.user.findUniqueOrThrow({ where: { id: payload.id }, select: { id: true, name: true, role: true } });
    next();
  } catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
};
const managerOnly = (req, res, next) => req.user.role === Role.MANAGER ? next() : res.status(403).json({ error: 'Manager permission is required.' });

app.post('/api/auth/login', async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const user = await db.user.findUnique({ where: { email: body.data.email } });
  if (!user || !await bcrypt.compare(body.data.password, user.passwordHash)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: jwt.sign({ id: user.id }, secret, { expiresIn: '8h' }), user: { id: user.id, name: user.name, role: user.role } });
});

app.get('/api/products', auth, async (req, res) => {
  const products = await db.product.findMany({ include: { supplier: true }, orderBy: { name: 'asc' } });
  res.json(products.map(p => cleanProduct(p, req.user.role)));
});
app.post('/api/products', auth, managerOnly, async (req, res) => {
  const parsed = z.object({ sku:z.string().min(1), name:z.string().min(1), category:z.string().min(1), reorderLevel:z.number().int().min(0), costPrice:z.number().min(0), salePrice:z.number().min(0), supplierId:z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product details.' });
  try { res.status(201).json(await db.product.create({ data: parsed.data })); } catch { res.status(409).json({ error: 'SKU already exists.' }); }
});
app.patch('/api/products/:id/price', auth, managerOnly, async (req, res) => {
  const prices = z.object({ costPrice:z.number().min(0), salePrice:z.number().min(0) }).safeParse(req.body);
  if (!prices.success) return res.status(400).json({ error: 'Invalid prices.' });
  res.json(await db.product.update({ where:{ id:req.params.id }, data:prices.data }));
});

const movementSchema = z.object({ productId:z.string(), type:z.enum(['STOCK_IN','SALE','DAMAGE','ADJUSTMENT']), quantity:z.number().int().positive(), reference:z.string().max(120).optional(), note:z.string().max(250).optional() });
async function applyMovement({ productId, type, quantity, reference, note, userId, source = MovementSource.MANUAL }) {
  return db.$transaction(async tx => {
    const product = await tx.product.findUniqueOrThrow({ where:{ id:productId } });
    const decrease = type === MovementType.SALE || type === MovementType.DAMAGE;
    if (decrease && product.quantity < quantity) throw new Error(`Only ${product.quantity} item(s) are available; this action would make stock negative.`);
    const after = product.quantity + (decrease ? -quantity : quantity);
    await tx.product.update({ where:{ id:productId }, data:{ quantity:after } });
    return tx.stockMovement.create({ data:{ productId, type, source, quantityBefore:product.quantity, changeQuantity:decrease ? -quantity : quantity, quantityAfter:after, reference, note, userId }, include:{ product:true, user:{select:{name:true}} } });
  });
}
app.post('/api/movements', auth, async (req, res) => {
  const parsed = movementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid product, type, and positive quantity.' });
  try { res.status(201).json(await applyMovement({ ...parsed.data, userId:req.user.id })); } catch (e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/movements', auth, async (req,res) => {
  const rows = await db.stockMovement.findMany({ take:100, orderBy:{createdAt:'desc'}, include:{ product:{select:{sku:true,name:true}}, user:{select:{name:true}} } });
  res.json(rows);
});
app.get('/api/dashboard', auth, async (req,res) => {
  const [products, recent, sales] = await Promise.all([
    db.product.findMany({ include:{supplier:true} }),
    db.stockMovement.findMany({ take:8, orderBy:{createdAt:'desc'}, include:{product:{select:{name:true}},user:{select:{name:true}}} }),
    db.stockMovement.groupBy({ by:['productId'], where:{type:'SALE',createdAt:{gte:new Date(new Date().setDate(new Date().getDate()-new Date().getDay()+1))}}, _sum:{changeQuantity:true}, orderBy:{_sum:{changeQuantity:'asc'}}, take:5 })
  ]);
  const productsById = Object.fromEntries(products.map(p=>[p.id,p]));
  res.json({ totalProducts:products.length, totalUnits:products.reduce((n,p)=>n+p.quantity,0), lowStock:products.filter(p=>p.quantity<=p.reorderLevel).map(p=>cleanProduct(p,req.user.role)), recent, topSellers:sales.map(s=>({name:productsById[s.productId]?.name, quantity:Math.abs(s._sum.changeQuantity || 0)})) });
});

app.post('/api/ai/proposals', auth, async (req,res) => {
  const parsed = movementSchema.pick({productId:true,type:true,quantity:true,reference:true}).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error:'Invalid proposal.' });
  const product = await db.product.findUnique({where:{id:parsed.data.productId}});
  if (!product) return res.status(404).json({error:'Product not found.'});
  const decreases = ['SALE','DAMAGE'].includes(parsed.data.type);
  if (decreases && product.quantity < parsed.data.quantity) return res.status(400).json({error:`Only ${product.quantity} item(s) are available; stock cannot go below zero.`});
  const proposal = await db.stockProposal.create({data:{...parsed.data, userId:req.user.id, expiresAt:new Date(Date.now()+10*60*1000)}});
  res.status(201).json({proposal, preview:{product:product.name,before:product.quantity,after:product.quantity+(decreases?-parsed.data.quantity:parsed.data.quantity)}});
});
app.post('/api/ai/proposals/:id/cancel', auth, async(req,res) => {
  const proposal=await db.stockProposal.findFirst({where:{id:req.params.id,userId:req.user.id,status:ProposalStatus.PENDING}});
  if (!proposal) return res.status(404).json({error:'Pending proposal not found.'});
  await db.stockProposal.update({where:{id:proposal.id},data:{status:ProposalStatus.CANCELLED}}); res.json({ok:true});
});
app.post('/api/ai/proposals/:id/confirm', auth, async(req,res) => {
  try {
    const result=await db.$transaction(async tx=>{
      const proposal=await tx.stockProposal.findFirstOrThrow({where:{id:req.params.id,userId:req.user.id,status:ProposalStatus.PENDING}});
      if(proposal.expiresAt<new Date()){ await tx.stockProposal.update({where:{id:proposal.id},data:{status:ProposalStatus.EXPIRED}}); throw new Error('This proposal has expired. Please ask again.'); }
      const product=await tx.product.findUniqueOrThrow({where:{id:proposal.productId}}); const dec=['SALE','DAMAGE'].includes(proposal.type);
      if(dec && product.quantity<proposal.quantity) throw new Error(`Only ${product.quantity} item(s) are now available.`);
      const after=product.quantity+(dec?-proposal.quantity:proposal.quantity);
      await tx.product.update({where:{id:product.id},data:{quantity:after}});
      const movement=await tx.stockMovement.create({data:{productId:product.id,type:proposal.type,source:MovementSource.AI_CONFIRMED,quantityBefore:product.quantity,changeQuantity:dec?-proposal.quantity:proposal.quantity,quantityAfter:after,reference:proposal.reference,userId:req.user.id}});
      await tx.stockProposal.update({where:{id:proposal.id},data:{status:ProposalStatus.CONFIRMED,confirmedMovementId:movement.id}}); return {movement,after};
    }); res.json(result);
  } catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/ai/chat', auth, async (req,res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({error:'Assistant is currently unavailable. Please use the inventory forms and try again later.'});
  // Deliberately no direct database or write access here. Connect approved, role-filtered tool calls in the next AI integration step.
  res.status(501).json({error:'AI tool integration is not configured yet.'});
});
app.listen(port,()=>console.log(`StockSense API running on http://localhost:${port}`));
