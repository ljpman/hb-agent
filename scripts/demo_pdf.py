"""Render a conspicuously simulated parameter receipt; never an insurer illustration."""
import io
import json
import sys
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
data = json.load(io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8'))
p = data['params']
out = io.BytesIO()
ink = colors.HexColor('#193b35')
muted = colors.HexColor('#61736d')
body = ParagraphStyle('body', fontName='STSong-Light', fontSize=10, leading=17, textColor=ink, alignment=TA_LEFT)
small = ParagraphStyle('small', parent=body, fontSize=8, leading=13, textColor=muted)
title = ParagraphStyle('title', parent=body, fontSize=23, leading=31, spaceAfter=9)
section = ParagraphStyle('section', parent=body, fontSize=12, leading=20, spaceBefore=17, spaceAfter=9)

def para(text, style=body):
    return Paragraph(escape(str(text)), style)

def footer(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#dfe7e2'))
    canvas.line(22*mm, 21*mm, 188*mm, 21*mm)
    canvas.setFont('STSong-Light', 8)
    canvas.setFillColor(muted)
    canvas.drawString(22*mm, 15*mm, 'HB AGENT / 模拟文件，不构成保司计划书')
    canvas.drawRightString(188*mm, 15*mm, f'{doc.page}')

doc = SimpleDocTemplate(out, pagesize=(210*mm, 297*mm), rightMargin=22*mm, leftMargin=22*mm,
                        topMargin=23*mm, bottomMargin=28*mm, title='模拟计划书 - 参数确认单', author='HB Agent Prototype')
flow = [para('HB AGENT / WORKING DEMO', small), Spacer(1, 7*mm), para('模拟计划书 · 参数确认单', title),
        para('此文件仅用于验证产品操作流程。示例保司与演示储蓄计划均为虚构，不含收益、现金价值或保障承诺。'),
        Spacer(1, 7*mm)]
notice = Table([[para('模拟文件 / 非保司官方文件')]], colWidths=[166*mm])
notice.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#f6eee0')),('LEFTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),11),('BOTTOMPADDING',(0,0),(-1,-1),11)]))
flow += [notice, para('01  已确认的演示参数', section)]
rows = [
    ['产品', '演示储蓄计划 / DEMO-2026.1'], ['被保险人年龄', f"{p['age']} 岁"],
    ['被保险人性别', p['gender']], ['吸烟状态', '吸烟' if p['smoker'] else '不吸烟'],
    ['币种', p['currency']], ['年缴保费', f"{p['currency']} {p['annualPremium']}"],
    ['缴费年期', f"{p['paymentTerm']} 年"], ['方案版本', f"V{data['version']}"]]
table = Table([[para(a), para(b)] for a,b in rows], colWidths=[55*mm,111*mm])
table.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),0.4,colors.HexColor('#e0e7e2')),
                          ('LEFTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
flow += [table, para('02  文件来源与使用范围', section),
         para('来源：本地模拟服务。以上内容仅复述经纪已确认的输入，不进行利益演示计算。真实保司接入后，需要以官方文件逐项核验。'),
         Spacer(1, 4*mm), para('讲解包可引用本页输入参数，不能将其作为真实产品条款、保证利益或退保价值的依据。'),
         Spacer(1, 8*mm), para(f"任务编号：{data['id']}", small), para(f"创建时间：{data['createdAt']}", small)]
doc.build(flow, onFirstPage=footer, onLaterPages=footer)
sys.stdout.buffer.write(out.getvalue())
